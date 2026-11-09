"""Testi sincronizzati.

Strategia:
1. Cerca il testo ufficiale su LRCLIB (database aperto di testi, spesso già sincronizzati per riga).
2. Trascrive la traccia vocale isolata con Whisper ottenendo il tempo di ogni parola cantata.
3. Allinea il testo ufficiale alle parole di Whisper: ogni parola del testo eredita il tempo reale
   in cui viene cantata nel video (che può differire dalla versione album: intro, pause, ecc.).
4. Se il testo non si trova, usa direttamente la trascrizione di Whisper.
"""

from __future__ import annotations

import logging
import os
import re
import statistics
import threading
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Callable

import httpx

from . import config, romaji

log = logging.getLogger(__name__)

LRCLIB = "https://lrclib.net/api"


@dataclass
class Word:
    text: str
    start: float = -1.0
    end: float = -1.0
    onset: bool = False  # Whisper l'ha sentita attaccare dopo una pausa (tempo d'inizio affidabile)
    run: int = 0  # abbinata dentro una sequenza di quante parole consecutive (1 = parola isolata)
    orig: str = ""  # testo originale (kana/kanji) quando `text` è la sua trascrizione in romaji


@dataclass
class Line:
    words: list[Word]
    lrc_time: float | None = None  # tempo LRC originale (se disponibile)
    anchor: float | None = None  # inizio della riga nel video (tempo LRC corretto dallo scarto locale)
    orig: str = ""  # riga originale in giapponese, mostrata sotto il romaji

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)


# --------------------------------------------------------------------------- LRCLIB


def _client() -> httpx.Client:
    return httpx.Client(timeout=15, headers={"User-Agent": config.USER_AGENT})


def fetch_lrclib(artist: str, title: str, duration: float) -> dict | None:
    """Restituisce il record LRCLIB migliore (preferendo quelli sincronizzati) o None."""
    try:
        with _client() as c:
            candidates: list[dict] = []
            if artist and title:
                r = c.get(
                    f"{LRCLIB}/get",
                    params={"artist_name": artist, "track_name": title, "duration": round(duration)},
                )
                if r.status_code == 200:
                    candidates.append(r.json())
                r = c.get(f"{LRCLIB}/search", params={"artist_name": artist, "track_name": title})
                if r.status_code == 200:
                    candidates.extend(r.json())
            if not candidates:
                r = c.get(f"{LRCLIB}/search", params={"q": f"{artist} {title}".strip()})
                if r.status_code == 200:
                    candidates.extend(r.json())
    except httpx.HTTPError as e:
        log.warning("LRCLIB non raggiungibile: %s", e)
        return None

    candidates = [c for c in candidates if c and not c.get("instrumental") and (c.get("plainLyrics") or c.get("syncedLyrics"))]
    if not candidates:
        return None

    def score(c: dict) -> tuple:
        # I video spesso hanno intro/outro: tolleriamo differenze di durata, ma premiamo la vicinanza.
        diff = abs((c.get("duration") or 0) - duration) if duration else 0
        return (diff < 45, bool(c.get("syncedLyrics")), -diff)

    return max(candidates, key=score)


_LRC_LINE = re.compile(r"^\s*((?:\[\d+:\d+(?:[.:]\d+)?\])+)\s*(.*)$")
_LRC_TS = re.compile(r"\[(\d+):(\d+)(?:[.:](\d+))?\]")


def parse_lrc(lrc: str) -> list[Line]:
    lines: list[Line] = []
    for raw in lrc.splitlines():
        m = _LRC_LINE.match(raw)
        if not m:
            continue
        text = m.group(2).strip()
        for ts in _LRC_TS.finditer(m.group(1)):
            mm, ss, frac = ts.group(1), ts.group(2), ts.group(3) or "0"
            t = int(mm) * 60 + int(ss) + int(frac) / (10 ** len(frac))
            if text:
                lines.append(Line([Word(w) for w in text.split()], lrc_time=t))
    lines.sort(key=lambda l: l.lrc_time or 0)
    return lines


def parse_plain(text: str) -> list[Line]:
    return [Line([Word(w) for w in l.split()]) for l in text.splitlines() if l.strip()]


# --------------------------------------------------------------------------- Giapponese


def romanize_lines(lines: list[Line]) -> int:
    """Righe giapponesi in romaji diviso in parole (vedi romaji.py). Restituisce le righe convertite."""
    done = 0
    for l in lines:
        text = l.text
        if not romaji.has_ja_chars(text):
            continue
        ws = romaji.words(text)
        if not ws:
            continue
        norm = romaji.normalize(text)
        l.words = [Word(r, orig=norm[c0:c1]) for r, c0, c1 in ws]
        l.orig = text
        done += 1
    return done


def romanize_sung(segments: list[list[Word]]) -> list[list[Word]]:
    """Parole di Whisper in romaji, con le stesse regole del testo: così le due parti si confrontano.

    Whisper divide il giapponese in pezzi che non sono parole (spesso un carattere alla volta):
    ogni segmento si riunisce, si divide in parole romaji e ogni parola prende il tempo dei
    caratteri che copre (interpolato dentro i pezzi di Whisper).
    """
    import bisect

    out: list[list[Word]] = []
    for seg in segments:
        if not any(romaji.has_ja_chars(w.text) for w in seg):
            out.append(seg)
            continue
        pieces = [romaji.normalize(w.text) for w in seg]
        bounds, pos = [], 0
        for pc in pieces:
            bounds.append(pos)
            pos += len(pc)
        text = "".join(pieces)
        ws = romaji.words(text)
        if ws is None:
            out.append(seg)
            continue

        def at(c: float) -> float:
            k = max(0, min(bisect.bisect_right(bounds, c) - 1, len(seg) - 1))
            n = max(len(pieces[k]), 1)
            f = min(max((c - bounds[k]) / n, 0.0), 1.0)
            return seg[k].start + f * (seg[k].end - seg[k].start)

        words = []
        for r, c0, c1 in ws:
            s, e = at(c0), at(c1 - 1e-6)
            words.append(Word(r, s, max(e, s + 0.05), orig=text[c0:c1]))
        if words:
            out.append(words)
    return out


# --------------------------------------------------------------------------- Whisper

_whisper = None
_whisper_lock = threading.Lock()


def _load_16k(path: Path):
    """Decodifica in mono 16 kHz float32 con ffmpeg (evita dipendenze da versioni di PyAV)."""
    import subprocess

    import numpy as np

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]
    out = subprocess.run(cmd, capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if out.returncode != 0:
        raise RuntimeError(f"ffmpeg: {out.stderr.decode(errors='ignore')[-300:]}")
    return np.frombuffer(out.stdout, dtype=np.float32).copy()


def _get_whisper():
    global _whisper
    from faster_whisper import WhisperModel

    with _whisper_lock:
        if _whisper is None:
            _whisper = WhisperModel(
                config.WHISPER_MODEL,
                # CTranslate2 usa la GPU solo con CUDA (NVIDIA): sulle altre resta la CPU.
                # Di default prende 4 thread; un thread per core fisico è più veloce (~12%).
                device="cpu",
                compute_type="int8",
                cpu_threads=max(4, (os.cpu_count() or 8) // 2),
                download_root=str(config.MODELS_DIR / "whisper"),
            )
        return _whisper


def transcribe(vocals: Path, on_progress: Callable[[float], None], audio=None) -> tuple[list[list[Word]], str]:
    """Trascrive la traccia vocale. Restituisce (segmenti di parole con tempi, lingua)."""
    model = _get_whisper()
    with _whisper_lock:
        segments, info = model.transcribe(
            _load_16k(vocals) if audio is None else audio,
            word_timestamps=True,
            vad_filter=True,
            condition_on_previous_text=False,
            beam_size=5,
        )
        result: list[list[Word]] = []
        for seg in segments:
            words = [Word(w.word.strip(), w.start, w.end) for w in (seg.words or []) if w.word.strip()]
            if words:
                result.append(words)
            if info.duration:
                on_progress(min(seg.end / info.duration, 1.0))
    return result, info.language or ""


# --------------------------------------------------------------------------- Allineamento


def _norm(word: str) -> str:
    w = unicodedata.normalize("NFKD", word.lower())
    return "".join(ch for ch in w if ch.isalnum())


def _distribute(words: list[Word], start: float, end: float) -> None:
    """Assegna tempi a parole consecutive proporzionalmente alla lunghezza."""
    if not words:
        return
    end = max(end, start + 0.2 * len(words))
    weights = [max(len(w.text), 1) + 1 for w in words]
    total = sum(weights)
    t = start
    for w, wt in zip(words, weights):
        dur = (end - start) * wt / total
        w.start, w.end = t, t + dur
        t += dur


def align(lines: list[Line], sung: list[Word], duration: float) -> float:
    """Allinea le parole del testo alle parole cantate. Restituisce la frazione di parole abbinate.

    Con i tempi per riga di LRCLIB l'abbinamento tiene conto di *quando* si canta (vedi
    _anchor_to_lrc) e le righe che il video non canta vengono tolte da `lines`; con un testo senza
    tempi (es. scritto a mano) si abbinano le parole nell'ordine.
    """
    if lines and all(l.lrc_time is not None for l in lines):
        kept, ratio = _anchor_to_lrc(lines, sung, duration)
        lines[:] = kept
        _interpolate([w for l in lines for w in l.words], duration)
        return ratio

    flat = [w for l in lines for w in l.words]
    a = [_norm(w.text) for w in flat]
    b = [_norm(w.text) for w in sung]
    sm = SequenceMatcher(None, a, b, autojunk=False)
    matched = 0
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            j = blk.b + k
            src, dst = flat[blk.a + k], sung[j]
            src.start, src.end = dst.start, dst.end
            src.onset = j == 0 or dst.start - sung[j - 1].end > 0.15
            src.run = blk.size
            matched += 1
    ratio = matched / max(len(flat), 1)
    _interpolate(flat, duration)
    return ratio


_CUT_JUMP = 3.0  # s: scarto che torna indietro di più di così fra due tratti = strofa tagliata nel video
_MISS = 3.0  # costo di una riga che con lo scarto scelto non trova le sue parole nella voce
_SWITCH = 8.0  # costo di un cambio di scarto: serve l'evidenza di parecchie righe (un taglio vero nel video)
_MAX_SHIFT = 150.0  # s: scarti presi in considerazione fra il testo di LRCLIB e il video
_SPAN_MAX = 12.0  # s: durata massima di una riga per cercarne le parole nella voce


def _spans(lines: list[Line]) -> list[float]:
    """Durata di ogni riga secondo LRCLIB (fino alla riga dopo, al massimo _SPAN_MAX)."""
    out = []
    for i, l in enumerate(lines):
        nxt = lines[i + 1].lrc_time if i + 1 < len(lines) else l.lrc_time + 0.6 * len(l.words) + 2
        out.append(min(max(nxt - l.lrc_time, 0.4 * len(l.words)), _SPAN_MAX))
    return out


def _candidate_shifts(lines: list[Line], where: dict[str, list[float]]) -> list[float]:
    """Scarti (video − LRC) più votati: ogni parola del testo vota per le volte in cui la si sente cantare."""
    import numpy as np

    bins = np.zeros(int(2 * _MAX_SHIFT / 0.5) + 1)
    for l in lines:
        for k, w in enumerate(l.words[:4]):  # le prime parole: la loro posizione nella riga è nota (~0,3 s a parola)
            for t in where.get(_norm(w.text), []):
                d = t - l.lrc_time - 0.3 * k
                if -_MAX_SHIFT <= d <= _MAX_SHIFT:
                    bins[int((d + _MAX_SHIFT) / 0.5)] += 1
    smooth = np.convolve(bins, np.ones(5), mode="same")  # ±1 s
    cands: list[float] = []
    for idx in np.argsort(-smooth):
        if smooth[idx] < 3 or len(cands) >= 8:
            break
        d = idx * 0.5 - _MAX_SHIFT
        if all(abs(d - c) > 2.5 for c in cands):
            cands.append(float(d))
    return cands or [0.0]


def _evidence(line: Line, start: float, span: float, where: dict[str, list[float]]) -> float:
    """Quota delle parole della riga che si sentono cantare nel tratto di video in cui cadrebbe."""
    words = [_norm(w.text) for w in line.words]
    words = [w for w in words if w]
    if not words:
        return 0.0
    lo, hi = start - 1.0, start + span + 1.0
    return sum(any(lo <= t <= hi for t in where.get(w, [])) for w in words) / len(words)


def _choose_shifts(lines: list[Line], where: dict[str, list[float]]) -> tuple[list[float], list[float]]:
    """Scarto di ogni riga, costante a tratti, e quanto la riga «torna» con quello scarto (0..1).

    Di solito il video ha un solo scarto rispetto al testo di LRCLIB (introduzione diversa); a volte
    taglia una strofa o aggiunge una parte e lo scarto cambia a metà brano. Per ogni riga si sceglie
    uno degli scarti più votati minimizzando le righe che non trovano le loro parole nella voce più un
    costo per ogni cambio: un ritornello che si ripete altrove non basta a cambiare tratto, una
    dozzina di righe coerenti con un altro scarto sì.
    """
    cands = _candidate_shifts(lines, where)
    spans = _spans(lines)
    m = len(cands)
    ev = [[_evidence(l, l.lrc_time + c, spans[i], where) for c in cands] for i, l in enumerate(lines)]
    cost = [0.0] * m
    back: list[list[int]] = []
    for i in range(len(lines)):
        here = [_MISS * (1 - ev[i][c]) for c in range(m)]
        if i == 0:
            cost, row = here, list(range(m))
        else:
            best = min(range(m), key=lambda k: cost[k])
            row, new = [], []
            for c in range(m):
                prev = c if cost[c] <= cost[best] + _SWITCH else best
                new.append(cost[prev] + (0 if prev == c else _SWITCH) + here[c])
                row.append(prev)
            cost = new
        back.append(row)
    c = min(range(m), key=lambda k: cost[k])
    path = [0] * len(lines)
    for i in range(len(lines) - 1, -1, -1):
        path[i] = c
        c = back[i][c]
    return [cands[c] for c in path], [ev[i][c] for i, c in enumerate(path)]


def _match_in_window(line: Line, lo: float, hi: float, sung: list[Word], times: list[float]) -> None:
    """Abbina le parole della riga a quelle cantate solo dentro il suo tratto di video, nell'ordine."""
    import bisect

    j0 = bisect.bisect_left(times, lo)
    j1 = bisect.bisect_right(times, hi)
    a = [_norm(w.text) for w in line.words]
    b = [_norm(s.text) for s in sung[j0:j1]]
    for blk in SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():
        for k in range(blk.size):
            w, jj = line.words[blk.a + k], j0 + blk.b + k
            s = sung[jj]
            w.start, w.end = s.start, s.end
            w.onset = jj == 0 or s.start - sung[jj - 1].end > 0.15
            w.run = blk.size  # parole abbinate in sequenza sono più affidabili di una parola isolata


def _anchor_to_lrc(lines: list[Line], sung: list[Word], duration: float = 0.0) -> tuple[list[Line], float]:
    """Mette il testo di LRCLIB a tempo con il video usando i tempi per riga come punti fermi.

    Restituisce le righe davvero cantate nel video e la quota di parole riconosciute nella voce.

    Il testo di LRCLIB spesso è quello del disco: il video può avere un'introduzione diversa, una
    strofa tagliata o una parte strumentale in più. Lo scarto si sceglie quindi tratto per tratto
    guardando *quando* le parole si sentono cantare (non solo in che ordine: i ritornelli si
    ripetono); le parole si abbinano poi dentro il tratto di video della loro riga. Le righe che il
    video non canta (strofa tagliata, oltre la fine del brano) si tolgono invece di comprimerle.
    """
    for l in lines:
        for w in l.words:
            w.start = w.end = -1.0
            w.run = 0
    where: dict[str, list[float]] = {}
    for s in sung:
        where.setdefault(_norm(s.text), []).append(s.start)
    times = [s.start for s in sung]
    n_lines = len(lines)
    off, ev = _choose_shifts(lines, where)
    spans = _spans(lines)
    confirmed = [ev[i] >= 0.5 for i in range(n_lines)]
    conf_idx = [i for i in range(n_lines) if confirmed[i]]

    keep = [True] * n_lines
    for a, b in zip(conf_idx, conf_idx[1:]):
        if off[b] < off[a] - _CUT_JUMP:  # il video salta una parte del disco: le righe in mezzo non si cantano
            for i in range(a + 1, b):
                keep[i] = False
    for i in range(n_lines):
        if not confirmed[i] and duration and lines[i].lrc_time + off[i] > duration - 1.0:
            keep[i] = False  # oltre la fine del video (versione del disco più lunga)
    idx = [i for i in range(n_lines) if keep[i]]

    # parole abbinate dentro il tratto di ciascuna riga; scarto misurato su quelle sentite
    raw: dict[int, tuple[float, bool]] = {}  # riga -> (scarto misurato, attacco dopo una pausa)
    for i in idx:
        l = lines[i]
        guess = l.lrc_time + off[i]
        _match_in_window(l, guess - 2.0, guess + spans[i] + 1.0, sung, times)
        first = next(((k, w) for k, w in enumerate(l.words[:4]) if w.start >= 0 and w.run >= 2), None)
        if first and abs(first[1].start - 0.3 * first[0] - guess) <= 2.0:
            raw[i] = (first[1].start - 0.3 * first[0] - l.lrc_time, first[0] == 0 and first[1].onset)
    # scarto affinato con le righe vicine dello stesso tratto: Whisper tende a far partire la prima
    # parola in anticipo (ingloba la pausa), la mediana delle righe con attacco netto è più affidabile
    starts = []
    for i in idx:
        near = [raw[j] for j in range(i - 8, i + 9) if j in raw and off[j] == off[i]]
        clean = [d for d, onset in near if onset]
        pool = clean if len(clean) >= 3 else [d for d, _ in near]
        starts.append(lines[i].lrc_time + (statistics.median(pool) if len(pool) >= 3 else off[i]))
    # taglio nel video: le righe del tratto precedente che si sovrappongono al successivo non si cantano
    pos = {i: k for k, i in enumerate(idx)}
    drop: set[int] = set()
    for a, b in zip(conf_idx, conf_idx[1:]):
        if keep[a] and keep[b] and off[b] < off[a] - _CUT_JUMP:
            for i in idx:
                # anche le righe che sarebbero ancora sullo schermo quando il tratto dopo comincia
                if i < b and starts[pos[i]] + min(spans[i], 1.5) >= starts[pos[b]] - 0.3:
                    drop.add(i)
    out_lines: list[Line] = []
    out_starts: list[float] = []
    for i, s in zip(idx, starts):
        if i in drop:
            continue
        if out_starts and s < out_starts[-1] + 0.3:
            if not confirmed[i]:
                continue  # riga non sentita che tornerebbe indietro: la si toglie
            s = out_starts[-1] + 0.3
        out_lines.append(lines[i])
        out_starts.append(s)
    if n_lines - len(out_lines):
        log.info("Testo: %d righe non cantate nel video (versione diversa da quella di LRCLIB)", n_lines - len(out_lines))

    total = sum(len(l.words) for l in lines)
    ratio = sum(w.start >= 0 for l in out_lines for w in l.words) / max(total, 1)

    for i, l in enumerate(out_lines):
        n = len(l.words)
        L = l.anchor = out_starts[i]
        R = out_starts[i + 1] if i + 1 < len(out_lines) else L + 0.6 * n + 2
        R = max(R, L + 0.25 * n)
        for k, w in enumerate(l.words):
            if w.start < 0:
                continue
            if w.start < L - 1.0 or w.start > R + 0.3 or (k == 0 and abs(w.start - L) > 1.5):
                w.start = w.end = -1.0
            else:
                w.end = min(w.end, max(R + 0.2, w.start + 0.3))  # la fine non sconfina nella riga dopo
        timed = [k for k, w in enumerate(l.words) if w.start >= 0]
        if not timed:
            _distribute(l.words, L, min(R - 0.1, L + 0.45 * n + 1))
            continue
        if timed[0] == 0:
            _clamp_first_word(l)
        else:
            # parole iniziali non riconosciute: partono dall'inizio della riga, non dalla fine della precedente
            k = timed[0]
            limit = l.words[k].start
            begin = min(L, limit - 0.18 * k)
            _distribute(l.words[:k], begin, limit)
    return out_lines, ratio


def _clamp_first_word(l: Line) -> bool:
    """La prima parola non parte prima dell'inizio ufficiale della riga (pausa assorbita da Whisper)."""
    first = l.words[0]
    if l.anchor is None or first.start < 0 or first.start >= l.anchor - 0.3:
        return False
    first.start = max(first.start, min(l.anchor, first.end - 0.15))
    return True


def clamp_line_starts(lines: list[Line]) -> int:
    return sum(_clamp_first_word(l) for l in lines)


def _interpolate(flat: list[Word], duration: float) -> None:
    """Riempie i tempi mancanti tra le parole già sincronizzate."""
    i = 0
    n = len(flat)
    while i < n:
        if flat[i].start >= 0:
            i += 1
            continue
        j = i
        while j < n and flat[j].start < 0:
            j += 1
        prev_end = flat[i - 1].end if i > 0 else max(0.0, (flat[j].start if j < n else duration) - 0.5 * (j - i))
        next_start = flat[j].start if j < n else min(duration or prev_end + 0.5 * (j - i), prev_end + 0.5 * (j - i) + 1)
        span_end = min(next_start, prev_end + 0.6 * (j - i) + 0.5)
        _distribute(flat[i:j], prev_end, max(span_end, prev_end + 0.15 * (j - i)))
        i = j
    # Garantisce monotonia
    for k in range(1, n):
        if flat[k].start < flat[k - 1].start:
            flat[k].start = flat[k - 1].start
        if flat[k].end < flat[k].start:
            flat[k].end = flat[k].start + 0.1


# --------------------------------------------------------------------------- Allineamento forzato

_ALIGN_MAX = 26.0  # durata massima di una finestra (Whisper ne elabora al massimo 30 s)
_PAD = 0.6  # margine di audio prima e dopo le righe di una finestra


def _clean(text: str) -> str:
    """Parola senza punteggiatura/virgolette (il tokenizer di Whisper le separerebbe)."""
    return "".join(ch for ch in text if ch.isalnum() or ch == "'").strip("'") or text


def _windows(lines: list[Line]) -> list[tuple[int, int]]:
    """Raggruppa righe consecutive in finestre di audio, spezzando nelle pause più lunghe."""
    out: list[tuple[int, int]] = []
    s, n = 0, len(lines)
    while s < n:
        j = s
        while j + 1 < n and lines[j + 1].words[-1].end - lines[s].words[0].start <= _ALIGN_MAX:
            j += 1
        if j + 1 < n and j > s:
            # tra le righe della seconda metà, taglia dove c'è la pausa più lunga
            def gap(k: int) -> float:
                return lines[k + 1].words[0].start - lines[k].words[-1].end

            j = max(range(s + (j - s) // 2, j + 1), key=gap)
        out.append((s, j))
        s = j + 1
    return out


def force_align(lines: list[Line], audio, language: str) -> int:
    """Rifinisce i tempi di ogni parola allineando il testo esatto alla voce con Whisper.

    I tempi approssimativi (riga per riga) servono solo a scegliere le finestre di audio;
    dentro ogni finestra Whisper sa *cosa* viene cantato e trova *quando*, parola per parola.
    Restituisce il numero di parole aggiornate.
    """
    from faster_whisper.tokenizer import Tokenizer
    from faster_whisper.transcribe import pad_or_trim

    lines = [l for l in lines if l.words and l.words[0].start >= 0]
    if not lines:
        return 0
    model = _get_whisper()
    tokenizer = Tokenizer(model.hf_tokenizer, model.model.is_multilingual, task="transcribe", language=language or "it")
    tokenizer_ja = Tokenizer(model.hf_tokenizer, model.model.is_multilingual, task="transcribe", language="ja")
    sr = 16000
    total = len(audio) / sr
    updated = 0
    bounds = _windows(lines)
    for wi, (a, b) in enumerate(bounds):
        group = lines[a : b + 1]
        prev_end = lines[a - 1].words[-1].end if a > 0 else 0.0
        next_start = lines[b + 1].words[0].start if b + 1 < len(lines) else total
        w0 = max(0.0, prev_end, group[0].words[0].start - _PAD)
        w1 = min(total, next_start, group[-1].words[-1].end + _PAD, w0 + 29.5)
        if w1 - w0 < 0.5:
            continue
        words = [w for l in group for w in l.words]
        ja = all(w.orig for w in words)
        # giapponese: si allinea il testo originale (Whisper non sa pronunciare il romaji), senza spazi
        cleaned = [_clean(w.orig) for w in words] if ja else [_clean(w.text) for w in words]
        sep = "" if ja else " "
        text = sep + sep.join(cleaned)
        # posizione (in caratteri) di ogni parola del testo, per ritrovarle dopo la tokenizzazione
        spans, pos = [], len(sep)
        for c in cleaned:
            spans.append((pos, pos + len(c)))
            pos += len(c) + len(sep)

        chunk = audio[int(w0 * sr) : int(w1 * sr)]
        with _whisper_lock:
            features = model.feature_extractor(chunk)
            num_frames = features.shape[-1]
            encoder_output = model.encode(pad_or_trim(features))
            tok = tokenizer_ja if ja else tokenizer
            result = model.find_alignment(tok, [tok.encode(text)], encoder_output, num_frames)
        aligned = result[0] if result else []
        if not aligned:
            continue

        # da parole di Whisper (che possono spezzare apostrofi ecc.) a parole del testo
        starts = [None] * len(words)
        ends = [None] * len(words)
        pos = 0
        for aw in aligned:
            a_start, a_end = pos, pos + len(aw["word"])
            pos = a_end
            for k, (c0, c1) in enumerate(spans):
                if c0 < a_end and a_start < c1:
                    t0, t1 = w0 + float(aw["start"]), w0 + float(aw["end"])
                    starts[k] = t0 if starts[k] is None else min(starts[k], t0)
                    ends[k] = t1 if ends[k] is None else max(ends[k], t1)
        for w, s, e in zip(words, starts, ends):
            # scarta risultati incoerenti con la posizione della riga (testo non cantato davvero)
            if s is None or e is None or abs(s - w.start) > 3.0:
                continue
            w.start, w.end = s, max(e, s + 0.08)
            updated += 1
    # monotonia
    flat = [w for l in lines for w in l.words]
    for k in range(1, len(flat)):
        if flat[k].start < flat[k - 1].start:
            flat[k].start = flat[k - 1].start
        if flat[k].end < flat[k].start:
            flat[k].end = flat[k].start + 0.08
    return updated


_HOP = 0.02  # risoluzione dell'inviluppo della voce (secondi)


SNAP_VERSION = 3  # se cambia, i testi già in libreria vengono riallineati all'attacco della voce all'avvio
_PHRASE_RANGE = 15.0  # dB sotto il volume tipico della frase entro cui la voce conta come «cantato»


def voice_activity(audio, sr: int = 16000):
    """Inviluppo della traccia vocale isolata: (dB per blocco da 20 ms, smussato su 60 ms; soglia del brano).

    La soglia del brano (28 dB sotto i passaggi più forti) separa il silenzio da tutto il resto, ma
    respiri, riverbero e residui degli strumenti la superano già: per l'attacco di ogni parola
    snap_to_voice usa anche il volume della frase stessa.
    """
    import numpy as np

    n = int(sr * _HOP)
    frames = audio[: len(audio) // n * n].reshape(-1, n)
    db = 20 * np.log10(np.sqrt((frames**2).mean(axis=1)) + 1e-9)
    db = np.convolve(db, np.ones(3) / 3, mode="same")  # un click isolato non è una voce
    return db, max(float(np.percentile(db, 95)) - 28, -50)


def snap_to_voice(lines: list[Line], voice) -> int:
    """Nessuna parola si colora prima che il cantante attacchi davvero.

    Whisper tende ad attribuire la pausa prima di una frase (o un respiro) alla prima parola, che
    così si colora in anticipo. Per ogni riga si misura il volume tipico del cantato; se una parola
    inizia dove la voce è molto più bassa (silenzio, respiro, rumore di fondo), il suo inizio si
    sposta al primo istante in cui la voce arriva al livello della frase. Restituisce le parole corrette.
    """
    import numpy as np

    db, song_thr = voice
    fixed = 0
    probe = int(0.1 / _HOP)  # la voce deve attaccare entro 100 ms dall'inizio della parola…
    hold = int(0.12 / _HOP)  # …e restare sopra il livello per almeno 120 ms (un respiro o un click no)
    for l in lines:
        if not l.words:
            continue
        la, lb = int(l.words[0].start / _HOP), int(l.words[-1].end / _HOP)
        if lb - la < 5:
            continue
        phrase = float(np.percentile(db[la:lb], 75))  # volume tipico della riga cantata
        thr = max(song_thr, phrase - _PHRASE_RANGE)
        for w in l.words:
            a, b = int(w.start / _HOP), int(w.end / _HOP)
            if b - a < 2:
                continue
            above = db[a : b + hold] > thr
            # sustained[i]: voce sopra il livello per tutti i `hold` blocchi da i in poi
            run = np.convolve(above.astype(int), np.ones(hold, dtype=int), mode="valid") == hold
            on = np.flatnonzero(run[: b - a])
            if on.size and on[0] < probe:
                continue  # la parola attacca già con la voce
            if on.size:
                w.start = min((a + on[0]) * _HOP, w.end - 0.08)
                fixed += 1
    return fixed


_SUSTAIN_MAX = 8.0  # s: quanto può allungarsi al massimo l'ultima parola di una riga
_SUSTAIN_DIP = 0.3  # s: cali più brevi di così (vibrato, consonanti) non interrompono la nota tenuta


def extend_to_voice(lines: list[Line], voice) -> int:
    """L'ultima parola di ogni riga dura quanto la nota tenuta dal cantante.

    Whisper chiude l'ultima parola poco dopo l'attacco anche quando il cantante la tiene a lungo
    («primaveraaa…»): la riga sembrava finita e lo schermo mostrava il conto alla rovescia
    mentre si cantava ancora. La fine si sposta in avanti finché la voce resta al livello della
    frase, senza arrivare alla riga successiva. Restituisce le righe allungate.
    """
    import numpy as np

    db, song_thr = voice
    n = len(db)
    dip = int(_SUSTAIN_DIP / _HOP)
    fixed = 0
    for i, l in enumerate(lines):
        if not l.words:
            continue
        last = l.words[-1]
        nxt = next((m.words[0].start for m in lines[i + 1 :] if m.words), n * _HOP)
        la, lb = int(l.words[0].start / _HOP), int(last.end / _HOP)
        if lb - la < 5 or lb >= n:
            continue
        thr = max(song_thr, float(np.percentile(db[la:lb], 75)) - _PHRASE_RANGE)
        limit = min(n, int(min(nxt - 0.15, last.end + _SUSTAIN_MAX) / _HOP))
        end, quiet = lb, 0
        for k in range(lb, limit):
            if db[k] > thr:
                end, quiet = k, 0
            else:
                quiet += 1
                if quiet > dip:
                    break
        if (end - lb) * _HOP >= 0.2:
            last.end = end * _HOP
            fixed += 1
    return fixed


def resnap_saved(song_dir: Path) -> int | None:
    """Testo già in libreria: riallinea l'inizio delle parole all'attacco della voce (una volta sola).

    Non rifà la sincronizzazione: sposta solo in avanti gli inizi che cadono prima del cantato.
    Restituisce le parole corrette, o None se non c'era niente da fare.
    """
    import json

    path = song_dir / "lyrics.json"
    vocals = song_dir / "vocals.m4a"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if data.get("snap") == SNAP_VERSION or not data.get("lines") or not vocals.exists():
        return None
    lines = [
        Line([Word(w["t"], w["s"], w["e"], orig=w.get("o", "")) for w in l["words"]], orig=l.get("orig", ""))
        for l in data["lines"]
        if l.get("words")
    ]
    voice = voice_activity(_load_16k(vocals))
    fixed = snap_to_voice(lines, voice) + extend_to_voice(lines, voice)
    out = to_json(lines, data.get("source", ""), data.get("language", ""))
    path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return fixed


def _split_long(words: list[Word], max_words: int = 9) -> list[list[Word]]:
    if len(words) <= max_words:
        return [words]
    parts = -(-len(words) // max_words)
    size = -(-len(words) // parts)
    return [words[i : i + size] for i in range(0, len(words), size)]


def to_json(lines: list[Line], source: str, language: str) -> dict:
    out = []
    for l in lines:
        if not l.words:
            continue
        item = {
            "start": round(l.words[0].start, 3),
            "end": round(l.words[-1].end, 3),
            "text": l.text,
            "words": [{"t": w.text, "s": round(w.start, 3), "e": round(w.end, 3)} for w in l.words],
        }
        orig = l.orig or "".join(w.orig or w.text for w in l.words) if any(w.orig for w in l.words) else l.orig
        if orig:
            item["orig"] = orig  # riga originale (giapponese) sotto il romaji
            for w, d in zip(l.words, item["words"]):
                if w.orig:
                    d["o"] = w.orig
        out.append(item)
    return {"source": source, "language": language, "snap": SNAP_VERSION, "lines": out}


def _cached_transcription(vocals: Path, audio, on_progress: Callable[[float], None]) -> tuple[list[list[Word]], str]:
    """Trascrizione di Whisper, salvata accanto alla voce: rigenerare il testo diventa rapido."""
    import json

    cache = vocals.with_name("whisper.json")
    key = f"{config.WHISPER_MODEL}:{vocals.stat().st_size}"
    try:
        data = json.loads(cache.read_text(encoding="utf-8"))
        if data.get("key") == key:
            return [[Word(t, s, e) for t, s, e in seg] for seg in data["segments"]], data["language"]
    except (OSError, ValueError, KeyError):
        pass
    segments, language = transcribe(vocals, on_progress, audio=audio)
    try:
        cache.write_text(
            json.dumps({"key": key, "language": language, "segments": [[(w.text, w.start, w.end) for w in seg] for seg in segments]}, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError:
        pass
    return segments, language


def build(
    vocals: Path,
    artist: str,
    title: str,
    duration: float,
    on_progress: Callable[[float, str], None],
    text: str | None = None,
) -> dict:
    """Testo sincronizzato. Con `text` (scritto a mano dall'app principale) non si cerca online:
    si sincronizzano con la voce esattamente quelle righe."""
    lines: list[Line] = []
    synced = False
    record = None
    if text is not None:
        lines = parse_plain(text)
    else:
        on_progress(0.02, "Cerco il testo online…")
        record = fetch_lrclib(artist, title, duration)
    if record:
        if record.get("syncedLyrics"):
            lines, synced = parse_lrc(record["syncedLyrics"]), True
        if not lines and record.get("plainLyrics"):
            lines = parse_plain(record["plainLyrics"])

    on_progress(0.08, "Ascolto la voce per sincronizzare le parole…")
    audio = _load_16k(vocals)
    voiced = voice_activity(audio)
    sung_segments, language = _cached_transcription(
        vocals, audio, lambda p: on_progress(0.08 + 0.72 * p, "Sincronizzo le parole…")
    )
    # Giapponese: testo e voce in romaji diviso in parole, così si confrontano e si colorano parola per parola
    ja_text = any(romaji.is_japanese(l.text) for l in lines)
    if ja_text or language == "ja":
        if romanize_lines(lines):
            log.info("Testo giapponese convertito in romaji")
        sung_segments = romanize_sung(sung_segments)
    sung = [w for seg in sung_segments for w in seg]

    if lines and sung:
        ratio = align(lines, sung, duration)
        log.info("Allineamento testo: %.0f%% parole abbinate", ratio * 100)
        # il testo scritto a mano si tiene comunque: è quello giusto, va solo messo a tempo
        if ratio >= 0.3 or text is not None:
            # Rifinitura: Whisper allinea il testo esatto alla voce, parola per parola.
            on_progress(0.82, "Allineo ogni parola alla voce…")
            try:
                n = force_align(lines, audio, language)
                log.info("Allineamento forzato: %d parole", n)
            except Exception:
                log.exception("Allineamento forzato non riuscito: uso i tempi stimati")
            clamp_line_starts(lines)
            snap_to_voice(lines, voiced)
            extend_to_voice(lines, voiced)
            return to_json(lines, "manual+whisper" if text is not None else "lrclib+whisper", language)
    if lines and synced:
        # Allineamento scarso (es. lingua non riconosciuta): tempi per riga di LRCLIB.
        for i, l in enumerate(lines):
            nxt = lines[i + 1].lrc_time if i + 1 < len(lines) else (l.lrc_time or 0) + 5
            _distribute(l.words, l.lrc_time or 0, min(nxt or 0, (l.lrc_time or 0) + 0.5 * len(l.words) + 1))
        return to_json(lines, "lrclib", language)
    if lines and text is not None:
        # nessuna voce riconosciuta: le righe scritte a mano si distribuiscono su tutto il brano
        _distribute([w for l in lines for w in l.words], 0, duration)
        return to_json(lines, "manual", language)
    if sung_segments:
        lines = [Line(part) for seg in sung_segments for part in _split_long(seg)]
        snap_to_voice(lines, voiced)
        extend_to_voice(lines, voiced)
        return to_json(lines, "whisper", language)
    if lines:
        _distribute([w for l in lines for w in l.words], 0, duration)
        return to_json(lines, "lrclib-unsynced", language)
    return {"source": "none", "language": language, "lines": []}
