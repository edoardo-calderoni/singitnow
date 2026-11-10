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


def placed_ratio(lines: list[Line], sung: list[Word], near: float = 1.5) -> float:
    """Quota delle parole del testo (di almeno 3 lettere) che cadono dove la voce le canta (±`near` s)."""
    import bisect

    heard = sorted((w.start, _norm(w.text)) for w in sung if _norm(w.text))
    times = [t for t, _ in heard]
    ok = tot = 0
    for l in lines:
        for w in l.words:
            n = _norm(w.text)
            if len(n) < 3:
                continue
            tot += 1
            lo, hi = bisect.bisect_left(times, w.start - near), bisect.bisect_right(times, w.start + near)
            ok += any(_similar(n, heard[i][1]) > 0 for i in range(lo, hi))
    return ok / tot if tot else 0.0


# frasi che Whisper «sente» nei silenzi: vengono dai sottotitoli con cui è stato addestrato
_HALLUCINATION = re.compile(
    r"sottotitoli|amara\.org|qtss|thanks? for watching|subtitles? by|sous-titr|untertitel|subt[ií]tulos", re.I
)


def transcribe(
    vocals: Path, on_progress: Callable[[float], None], audio=None, language: str | None = None, vad: bool = True
) -> tuple[list[list[Word]], str]:
    """Trascrive la traccia vocale. Restituisce (segmenti di parole con tempi, lingua).

    Con un testo da sincronizzare (`vad=False`, `language` presa dal testo) si ascolta tutta la voce:
    il filtro del parlato scarta intere strofe cantate (ritornelli tenuti, voce con effetti), e la
    lingua riconosciuta dai primi 30 secondi a volte è sbagliata (italiano scambiato per latino).
    Senza testo il filtro resta: nei silenzi Whisper inventerebbe frasi che finirebbero sullo schermo.
    """
    model = _get_whisper()
    with _whisper_lock:
        segments, info = model.transcribe(
            _load_16k(vocals) if audio is None else audio,
            word_timestamps=True,
            vad_filter=vad,
            condition_on_previous_text=False,
            beam_size=5,
            language=language or None,
            language_detection_segments=4,
        )
        result: list[list[Word]] = []
        for seg in segments:
            if _HALLUCINATION.search(seg.text or ""):
                continue  # frase che Whisper inventa nei silenzi (titoli di coda dei sottotitoli)
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


def _similar(a: str, b: str) -> float:
    """Somiglianza fra una parola del testo e una cantata (già normalizzate), 0 se troppo diverse.

    Whisper scrive spesso la parola in italiano standard o la spezza sull'apostrofo («pe'»/«per»,
    «elemosina»/«emosina», «fateme»/«fatemi»): contano anche le parole quasi uguali. Le parole corte
    devono somigliarsi di più («pe» non è «e»)."""
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    r = SequenceMatcher(None, a, b, autojunk=False).ratio()
    return r if r >= (0.75 if min(len(a), len(b)) <= 3 else 0.6) else 0.0


def _match_in_window(line: Line, lo: float, hi: float, sung: list[Word], times: list[float]) -> None:
    """Abbina le parole della riga a quelle cantate solo dentro il suo tratto di video, nell'ordine.

    Si cerca l'abbinamento migliore per tutta la riga (somma delle somiglianze), non il primo che
    capita: prima una parola che compariva anche all'inizio della riga dopo («Sta pe' strada…» →
    il «Pe'» di «Pe' quer padre») poteva portarsi via tutte le parole in mezzo.
    """
    import bisect

    j0 = bisect.bisect_left(times, lo)
    j1 = bisect.bisect_right(times, hi)
    a = [_norm(w.text) for w in line.words]
    b = [_norm(s.text) for s in sung[j0:j1]]
    n, m = len(a), len(b)
    if not n or not m:
        return
    sim = [[_similar(x, y) for y in b] for x in a]
    # best[i][j]: miglior punteggio abbinando a[i:] con b[j:]
    best = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            take = best[i + 1][j + 1] + sim[i][j] if sim[i][j] else 0.0
            best[i][j] = max(take, best[i + 1][j], best[i][j + 1])
    pairs: list[tuple[int, int]] = []
    i = j = 0
    while i < n and j < m:
        if sim[i][j] and best[i][j] == best[i + 1][j + 1] + sim[i][j]:
            pairs.append((i, j))
            i, j = i + 1, j + 1
        elif best[i][j] == best[i + 1][j]:
            i += 1
        else:
            j += 1
    # parole abbinate in sequenza (consecutive in entrambi) sono più affidabili di una parola isolata
    runs: list[list[tuple[int, int]]] = []
    for p in pairs:
        if runs and p == (runs[-1][-1][0] + 1, runs[-1][-1][1] + 1):
            runs[-1].append(p)
        else:
            runs.append([p])
    for run in runs:
        for i, j in run:
            w, jj = line.words[i], j0 + j
            s = sung[jj]
            w.start, w.end = s.start, s.end
            w.onset = jj == 0 or s.start - sung[jj - 1].end > 0.15
            w.run = len(run)


def _rematch_in_gaps(
    lines: list[Line], idx: list[int], off: list[float], spans: list[float], sung: list[Word], times: list[float]
) -> dict[int, float]:
    """Righe che non trovano le loro parole vicino al tempo di LRCLIB: le si cerca in tutto lo spazio
    fra la riga prima e quella dopo.

    A volte i tempi di LRCLIB sono sbagliati attorno a una pausa strumentale: in «Stella» (Venditti)
    «Proteggi i nostri figli puri…» è subito dopo il ritornello e poi ci sono 35 s vuoti, mentre nel
    video la pausa viene prima e la riga si canta 28 s più tardi. Restituisce {riga: nuovo inizio}
    per le righe spostate (abbinate di nuovo in sequenza, con almeno metà delle parole).

    Una riga ritrovata può scavalcare al massimo un'altra riga rispetto all'ordine di LRCLIB: nei
    ritornelli ripetuti («Shallow») le stesse parole si sentono anche molto prima, e spostarla là
    schiaccerebbe tutte le righe in mezzo.
    """
    def matched(l: Line) -> int:
        return sum(1 for w in l.words if w.start >= 0 and w.run >= 2)

    moved: dict[int, float] = {}
    for pos, i in enumerate(idx):
        l = lines[i]
        n = len(l.words)
        if n < 3 or matched(l) * 2 >= n:
            continue
        guess = l.lrc_time + off[i]
        prev = [w.end for j in idx[:pos] for w in lines[j].words if w.start >= 0]
        nxt = [w.start for j in idx[pos + 1 :] for w in lines[j].words if w.start >= 0]
        lo = max(prev) if prev else 0.0
        hi = min(nxt) if nxt else (times[-1] + 1.0 if times else 0.0)
        if hi - lo <= spans[i] + 3.0:
            continue  # lo spazio è quello già guardato
        saved = [(w.start, w.end, w.onset, w.run) for w in l.words]
        for w in l.words:
            w.start = w.end = -1.0
            w.run = 0
        _match_in_window(l, lo, hi, sung, times)
        new = None
        if matched(l) * 2 >= n:
            k, first = next((k, w) for k, w in enumerate(l.words) if w.start >= 0 and w.run >= 2)
            new = first.start - 0.3 * k
            a, b = sorted((new, guess))
            if sum(1 for j in idx if j != i and a < lines[j].lrc_time + off[j] < b) > 1:
                new = None  # scavalcherebbe più righe: sono le parole di un'altra ripetizione
        if new is not None:
            moved[i] = new
            log.info("Riga «%s» ritrovata a %.1f s (LRCLIB la metteva a %.1f s)", l.text, moved[i], guess)
        else:
            for w, (a, b, o, r) in zip(l.words, saved):
                w.start, w.end, w.onset, w.run = a, b, o, r
    return moved


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
    moved = _rematch_in_gaps(lines, idx, off, spans, sung, times)
    for i in idx:
        l = lines[i]
        guess = l.lrc_time + off[i]
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
        if i in moved:
            starts[-1] = moved[i]  # riga ritrovata fuori dal suo tratto: parte dove la si canta
    # righe senza nessuna parola sentita che resterebbero dopo una riga ritrovata più indietro
    # («So' distrutto» prima di «Cameriè», ritrovata 3 s prima): si mettono nello spazio prima di lei
    for q, i in enumerate(idx):
        if i not in moved:
            continue
        p = q
        while (
            p > 0
            and idx[p - 1] not in moved
            and not any(w.start >= 0 for w in lines[idx[p - 1]].words)
            and starts[p - 1] >= starts[q] - 0.3
        ):
            p -= 1
        k = q - p
        if k:
            lo = starts[p - 1] if p > 0 else max(0.0, starts[q] - 2.0 * k)
            for j in range(k):
                starts[p + j] = lo + (j + 1) * (starts[q] - lo) / (k + 1)
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
            if not confirmed[i] and i not in moved:
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


# se cambia, i testi già in libreria vengono riallineati alla voce all'avvio
# (4: note tenute, fix_held_notes; 5: ogni parola tenuta si allunga, non solo l'ultima della riga;
#  6: la nota tenuta finisce al primo stacco dopo le sillabe della parola;
#  7: parole che partono sulla coda della parola prima, o in pieno silenzio)
SNAP_VERSION = 7
_PHRASE_RANGE = 15.0  # dB sotto il volume tipico della frase entro cui la voce conta come «cantato»
_SNAP_GAP = 0.3  # s di silenzio vero dentro una parola: la voce prima era la coda della parola precedente


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

    Altri due casi in cui la parola partiva in anticipo («Well, I found a girl, beautiful…»):
    - la parola inizia sulla coda della parola prima, ancora tenuta, poi c'è silenzio vero e solo
      dopo il cantante attacca: la voce all'inizio non è sua, la parola parte dall'attacco;
    - nella parola non c'è voce per niente (il cantante attacca appena dopo la sua fine): si
      colora solo nell'ultimo istante, non per tutto il silenzio che la precede.
    """
    import numpy as np

    db, song_thr = voice
    fixed = 0
    probe = int(0.1 / _HOP)  # la voce deve attaccare entro 100 ms dall'inizio della parola…
    hold = int(0.12 / _HOP)  # …e restare sopra il livello per almeno 120 ms (un respiro o un click no)
    gap = int(_SNAP_GAP / _HOP)
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
            if not on.size:
                # nessuna voce nella parola (al massimo l'attacco proprio in fondo): il cantante
                # attacca dopo, si colora solo alla fine
                voiced = np.flatnonzero(db[a:b] > song_thr)
                first = voiced[0] if voiced.size else b - a
                if first >= probe and b - a > probe + 5:
                    w.start = max(w.start, min((a + first) * _HOP, w.end - 0.15))
                    fixed += 1
                continue
            if on[0] >= probe:
                w.start = min((a + on[0]) * _HOP, w.end - 0.08)
                fixed += 1
                continue
            # la parola attacca sulla voce: ma se quella voce viene da prima della parola (coda della
            # parola precedente) ed è seguita da silenzio vero, la parola comincia dopo il silenzio
            if a < 3 or not np.all(db[a - 3 : a] > thr):
                continue
            quiet = db[a:b] <= song_thr
            k = int(np.argmax(quiet)) if quiet.any() else -1
            if k < 0:
                continue
            q = int(np.argmax(~quiet[k:])) if (~quiet[k:]).any() else len(quiet) - k
            if q < gap:
                continue
            after = np.flatnonzero(run[k + q : b - a])
            if after.size:
                w.start = min((a + k + q + after[0]) * _HOP, w.end - 0.08)
                fixed += 1
    return fixed


_SUSTAIN_MAX = 8.0  # s: durata massima di una parola tenuta (dall'inizio della parola)
_SUSTAIN_DIP = 0.3  # s: cali più brevi di così (vibrato, consonanti) non interrompono la nota tenuta


def _sustain(db, thr: float, start: int, limit: int) -> int:
    """Ultimo blocco, da `start` a `limit`, in cui la voce tiene ancora la nota (cali brevi ammessi)."""
    dip = int(_SUSTAIN_DIP / _HOP)
    end, quiet = start, 0
    for k in range(start, limit):
        if db[k] > thr:
            end, quiet = k, 0
        else:
            quiet += 1
            if quiet > dip:
                break
    return end


def extend_to_voice(lines: list[Line], voice, sung: list[Word] | None = None) -> int:
    """Ogni parola dura quanto la nota tenuta dal cantante, e non di più.

    Whisper chiude la parola poco dopo l'attacco anche quando il cantante la tiene a lungo
    («primaveraaa…», «E… EEEEEE… fateme»): la riga sembrava finita, o restava ferma a metà, mentre
    si cantava ancora. La fine si sposta in avanti finché la voce resta al livello della frase,
    senza arrivare alla parola (o alla riga) successiva.

    La nota tenuta però finisce al primo stacco di sillaba dopo la fine della parola sentita da
    Whisper (`sung`, che chiude le note lunghe un po' presto ma sa quando la parola è finita): dopo
    «un mattoooo» la voce restava sulla stessa nota con un «na-na-na» (o un coro), e la parola si
    colorava piano per altri 6 secondi. Gli stacchi prima di quel punto sono vibrato o consonanti
    della parola stessa; le pause vere fermano già la voce che cala. Le note finali allungate così
    in passato si riaccorciano. Restituisce le parole cambiate.
    """
    import bisect

    import numpy as np

    db, song_thr = voice
    n = len(db)
    # stacchi dentro la voce (consonanti): non le ripartenze dopo il silenzio
    cuts = [i for i in voice_onsets(voice) if db[i] > song_thr] if sung else []
    heard = _heard(sung or [])
    fixed = 0
    for i, l in enumerate(lines):
        if not l.words:
            continue
        nxt_line = next((m.words[0].start for m in lines[i + 1 :] if m.words), n * _HOP)
        la, lb = int(l.words[0].start / _HOP), int(l.words[-1].end / _HOP)
        if lb - la < 5 or lb >= n:
            continue
        thr = max(song_thr, float(np.percentile(db[la:lb], 75)) - _PHRASE_RANGE)
        for j, w in enumerate(l.words):
            if w.start < 0:
                continue
            last = j + 1 == len(l.words)
            nxt = nxt_line - 0.15 if last else l.words[j + 1].start
            # fine della nota: il primo stacco dopo la fine della parola sentita da Whisper
            h = heard(w.text, w.start - 1.0, w.start + 1.0) if cuts else None
            cut = n * _HOP
            if h is not None:
                k = bisect.bisect_right(cuts, int((max(h[1], w.start) + 0.1) / _HOP))
                cut = cuts[k] * _HOP if k < len(cuts) else cut
            if last and w.end - cut > 0.5 and cut > w.start + 0.3:
                w.end = cut  # allungata in passato oltre la nota (testi già salvati)
                fixed += 1
                continue
            we = int(w.end / _HOP)
            if we >= n or min(nxt, cut) - w.end < 0.2:
                continue  # la parola dopo (o la sillaba dopo) attacca subito: niente da allungare
            # limite contato dall'inizio della parola: ripetere il controllo non la allunga ancora
            limit = min(nxt, cut, w.start + _SUSTAIN_MAX)
            end = _sustain(db, thr, we, min(n, int(limit / _HOP)))
            if (end - we) * _HOP >= 0.2:
                w.end = min(end * _HOP, limit)
                fixed += 1
    return fixed


_ONSET_DIP = 6.0  # dB: calo della voce che separa due sillabe (consonante, respiro, stacco)
_ONSET_WIN = 0.15  # s: entro quanto, prima e dopo il calo, la voce deve tornare su
_HELD_TRIGGER = 1.0  # s di nota già tenuta prima dell'inizio di una parola: la riga va ricontrollata
_LONG = 0.7  # s di voce oltre i quali una sillaba è «tenuta»
_VOWEL_GROUPS = re.compile(r"[aeiouy]+")


def _swollen_limit(syll: int) -> float:
    """Durata oltre la quale una parola di `syll` sillabe (senza nota finale) è sospetta."""
    return 0.6 * syll + 1.0


def syllables(word: str, language: str = "") -> int:
    """Sillabe (cantate) di una parola: gruppi di vocali. Esatto per l'italiano, indicativo per le altre."""
    w = _norm(word)
    n = len(_VOWEL_GROUPS.findall(w))
    if language == "en" and n > 1 and w.endswith("e") and not w.endswith(("le", "ee")):
        n -= 1  # «make», «time»: la e finale non si canta
    return max(1, n)


def voice_onsets(voice) -> list[int]:
    """Attacchi delle sillabe nella voce isolata (blocchi da _HOP): dove la voce riparte dopo un calo
    netto (consonante, respiro) o dopo il silenzio. Dentro una nota tenuta non ce ne sono, anche se
    l'intonazione sale o scende (vocalizzo)."""
    import numpy as np

    db, thr = voice
    n, w = len(db), int(_ONSET_WIN / _HOP)
    out: list[int] = []
    for i in range(1, n - 1):
        if db[i] > db[i - 1] or db[i] > db[i + 1]:
            continue  # non è un minimo locale
        right = float(np.max(db[i + 1 : i + w + 1]))
        left = float(np.max(db[max(0, i - w) : i]))
        if right <= thr or right - db[i] < _ONSET_DIP:
            continue
        if db[i] > thr and left - db[i] < _ONSET_DIP / 2:
            continue  # la voce stava solo salendo, nessuno stacco
        if out and float(np.max(db[out[-1] : i + 1])) <= thr:
            out[-1] = i  # più minimi nello stesso silenzio: conta l'ultimo, prima che la voce riparta
        else:
            out.append(i)
    return out


def _heard(sung: list[Word]) -> Callable[[str, float, float], tuple[float, float] | None]:
    """Cerca nella trascrizione di Whisper quando ha sentito una parola: (inizio, fine) della più
    simile (anche con qualche lettera diversa, «fateme»/«fatemi») fra quelle iniziate nell'intervallo."""
    heard = [(_norm(w.text), w.start, w.end) for w in sung if w.start >= 0]

    def find(text: str, lo: float, hi: float) -> tuple[float, float] | None:
        t, best, when = _norm(text), 0.0, None
        for n, s, e in heard:
            if lo <= s <= hi and t and n:
                r = SequenceMatcher(None, t, n).ratio()
                if r > best:
                    best, when = r, (s, e)
        return when if best >= 0.6 else None

    return find


def fix_held_notes(
    lines: list[Line], voice, sung: list[Word], language: str = "", onsets: list[int] | None = None
) -> int:
    """Le note tenute restano alla parola che si sta cantando.

    Su una vocale tenuta a lungo («E… EEEEEE… fateme cantà») la rifinitura parola per parola
    (force_align) può far iniziare le parole dopo in anticipo, anche di secondi, e il testo si colora
    mentre si canta ancora la nota. Una parola però non può iniziare in mezzo a una nota tenuta:
    deve partire da un attacco (consonante, stacco), e le sue sillabe devono trovare posto ciascuna
    sul proprio attacco.

    Una riga si corregge solo se due indizi indipendenti sono d'accordo:
    1. una parola inizia dopo più di _HELD_TRIGGER secondi di nota già tenuta, senza stacchi;
    2. la trascrizione di Whisper (`sung`) aveva sentito quella parola più vicino alla nuova
       posizione che a quella attuale.
    Da soli gli stacchi non bastano: nel canto legato le consonanti morbide (l, m, n, r, v) non
    fanno calare la voce e sembrerebbero note tenute anche dove i tempi sono giusti.

    Le parole della riga si ridistribuiscono sugli attacchi della voce: ogni parola sul numero giusto
    di sillabe, la nota lunga solo sull'ultima sillaba di una parola, il più vicino possibile ai
    tempi attuali. Restituisce le righe corrette.
    """
    import numpy as np

    db, song_thr = voice
    marks = np.asarray(voice_onsets(voice) if onsets is None else onsets, dtype=float) * _HOP
    heard = _heard(sung)
    fixed = 0
    for l in lines:
        words = l.words
        if len(words) < 2 or words[0].start < 0:
            continue
        la, lb = int(words[0].start / _HOP), int(words[-1].end / _HOP)
        if lb - la < 10 or lb > len(db):
            continue
        thr = max(song_thr, float(np.percentile(db[la:lb], 75)) - _PHRASE_RANGE)
        line_start, line_end = words[0].start, words[-1].end
        starts = [line_start] + [float(t) for t in marks if line_start + 0.1 < t < line_end - 0.1]
        ends = starts[1:] + [line_end]

        def voiced(t0: float, t1: float) -> float:
            return float(np.count_nonzero(db[int(t0 / _HOP) : int(t1 / _HOP)] > thr)) * _HOP

        lengths = [voiced(a, b) for a, b in zip(starts, ends)]
        sylls = [syllables(w.text, language) for w in words]

        # A) parole che iniziano in mezzo a una nota tenuta senza stacchi
        held = []
        # B) parole di più sillabe che si portano dietro una nota tenuta non sull'ultima sillaba:
        #    la nota tenuta è della parola prima, la parola inizia dopo
        swollen = []
        for j, w in enumerate(words[1:], 1):
            k = int(np.searchsorted(starts, w.start, side="right")) - 1
            if k >= 0 and w.start - starts[k] >= _HELD_TRIGGER and voiced(starts[k], w.start) >= _HELD_TRIGGER:
                held.append(j)
                continue
            nxt = words[j + 1].start if j + 1 < len(words) else w.end
            inside = [i for i in range(len(starts)) if w.start - 0.1 <= starts[i] < nxt - 0.1]
            if (
                sylls[j] >= 2
                and nxt - w.start > _swollen_limit(sylls[j])
                and any(lengths[i] >= _HELD_TRIGGER for i in inside[:-1])
            ):
                swollen.append(j)
        segs = len(starts)
        if not (held or swollen) or segs < len(words):
            continue

        def cost(j: int, a: int, b: int) -> float:
            """Parola j sugli attacchi a..b-1."""
            k, r = sylls[j], b - a
            c = 0.0 if j == 0 else 0.2 * abs(starts[a] - words[j].start)
            if r < k:
                c += 0.8 * (k - r)  # sillabe legate senza stacco
            elif r > k:
                # attacchi in più: poco male se sono note lunghe (vocale ripetuta, vibrato), molto se
                # sono sillabe brevi (probabilmente di un'altra parola)
                c += sum(sorted(0.3 if x >= 0.5 else 0.8 for x in lengths[a:b])[: r - k])
            for x in lengths[a : a + min(r, k) - 1]:  # sillabe non finali: niente note lunghe
                c += 1.5 * max(0.0, x - _LONG)
            return c

        inf = float("inf")
        best = [[inf] * (segs + 1) for _ in range(len(words) + 1)]
        back = [[0] * (segs + 1) for _ in range(len(words) + 1)]
        best[0][0] = 0.0
        for j in range(len(words)):
            for a in range(segs):
                if best[j][a] == inf:
                    continue
                for b in range(a + 1, segs + 1):
                    c = best[j][a] + cost(j, a, b)
                    if c < best[j + 1][b]:
                        best[j + 1][b], back[j + 1][b] = c, a
        if best[len(words)][segs] == inf:
            continue
        bounds, b = [], segs
        for j in range(len(words), 0, -1):
            a = back[j][b]
            bounds.append((a, b))
            b = a
        bounds.reverse()
        new = [starts[a] for a, _ in bounds]

        # conferma della trascrizione: le parole sospette si avvicinano a dove Whisper le ha sentite
        # e nessuna delle parole spostate se ne allontana
        confirmed, ok = False, True
        for j, (w, new_t) in enumerate(zip(words, new)):
            old_t = w.start
            if abs(new_t - old_t) < 0.3:
                continue
            h = heard(w.text, min(old_t, new_t) - 1.0, max(old_t, new_t) + 1.0)
            if j in held:
                if h is None or abs(new_t - h[0]) + 0.5 > abs(old_t - h[0]):
                    ok = False
                    break
                confirmed = True
            elif j in swollen:
                # anche Whisper l'ha sentita troppo lunga, e il nuovo inizio cade dentro la parola sentita
                if h is None or h[1] - h[0] <= _swollen_limit(sylls[j]) or not h[0] <= new_t <= h[1]:
                    ok = False
                    break
                confirmed = True
            # le altre: ammesse se restano vicine all'inizio sentito da Whisper o dentro la parola
            # sentita (anche Whisper fa iniziare troppo presto la parola dopo una nota tenuta)
            elif h is not None and abs(new_t - h[0]) > abs(old_t - h[0]) + 0.3 and not h[0] <= new_t <= h[1]:
                ok = False
                break
        if not (confirmed and ok):
            continue
        for j, (w, (a, b)) in enumerate(zip(words, bounds)):
            w.start = starts[a]
            if j + 1 < len(words):
                w.end = starts[b]  # fino alla parola dopo (pause comprese: la nota è ancora sua)
        fixed += 1
    return fixed


def resnap_saved(song_dir: Path) -> int | None:
    """Testo già in libreria: riallinea l'inizio delle parole all'attacco della voce (una volta sola).

    Non rifà la sincronizzazione: sposta in avanti gli inizi che cadono prima del cantato, allunga
    le note tenute a fine riga e rimette a posto le parole iniziate in mezzo a una nota tenuta.
    Restituisce le parole (e righe) corrette, o None se non c'era niente da fare.
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
    fixed = snap_to_voice(lines, voice)
    try:  # trascrizione di Whisper salvata: serve a confermare le correzioni sulle note tenute
        wj = json.loads((song_dir / "whisper.json").read_text(encoding="utf-8"))
        sung = [Word(t, s, e) for seg in wj["segments"] for t, s, e in seg]
    except (OSError, ValueError, KeyError, TypeError):
        sung = []
    fixed += extend_to_voice(lines, voice, sung)
    if sung:
        fixed += fix_held_notes(lines, voice, sung, data.get("language", ""))
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


_STOP = {
    "it": "il lo la che non di un una per sono mi ti si ma con del della come io tu quando cosa anche più è",
    "en": "the and you i to me my it is in that of your be all on we for don't can love what this",
    "es": "el la que de y en no me te mi es un una por con lo se tu yo para como",
    "fr": "le la les de et je tu que des un une est pas mon ne qui dans pour moi toi",
    "de": "der die das und ich du nicht ist ein eine mich dich mit wir sie zu es auf",
    "pt": "o a que de e não eu você um uma meu é com se do da para em",
}
_STOP_SETS = {k: set(v.split()) for k, v in _STOP.items()}


def guess_language(lines: list[Line]) -> str | None:
    """Lingua del testo (parole più comuni): per dirla a Whisper invece di fargliela indovinare."""
    if any(romaji.is_japanese(l.text) for l in lines):
        return "ja"
    words = [w.text.lower().strip(".,!?¡¿\"'()…") for l in lines for w in l.words]
    if len(words) < 20:
        return None
    hits = {k: sum(w in s for w in words) for k, s in _STOP_SETS.items()}
    best = max(hits, key=hits.get)
    ranked = sorted(hits.values(), reverse=True)
    if ranked[0] < 0.08 * len(words) or ranked[0] < 1.4 * ranked[1]:
        return None  # testo misto o lingua che non conosco: decide Whisper
    return best


def transcription_key(vocals: Path, language: str | None = None, vad: bool = True) -> str:
    """Chiave della trascrizione salvata: cambia con il modello, la voce e il modo di ascoltarla."""
    base = f"{config.WHISPER_MODEL}:{vocals.stat().st_size}"
    return base if vad and not language else f"{base}:full:{language or 'auto'}"


def full_transcription(song_dir: Path) -> bool:
    """La trascrizione salvata ascolta già tutta la voce (riconoscimento migliorato)?"""
    import json

    try:
        return ":full:" in json.loads((song_dir / "whisper.json").read_text(encoding="utf-8")).get("key", "")
    except (OSError, ValueError, AttributeError):
        return False


def _cached_transcription(
    vocals: Path, audio, on_progress: Callable[[float], None], language: str | None = None, vad: bool = True
) -> tuple[list[list[Word]], str]:
    """Trascrizione di Whisper, salvata accanto alla voce: rigenerare il testo diventa rapido."""
    import json

    cache = vocals.with_name("whisper.json")
    key = transcription_key(vocals, language, vad)
    try:
        data = json.loads(cache.read_text(encoding="utf-8"))
        if data.get("key") == key:
            return [[Word(t, s, e) for t, s, e in seg] for seg in data["segments"]], data["language"]
    except (OSError, ValueError, KeyError):
        pass
    segments, language = transcribe(vocals, on_progress, audio=audio, language=language, vad=vad)
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
    fallback: str | None = None,
) -> dict:
    """Testo sincronizzato. Con `text` (scritto a mano dall'app principale) non si cerca online:
    si sincronizzano con la voce esattamente quelle righe. `fallback`: testo già in libreria, da
    risincronizzare se online non si trova (LRCLIB irraggiungibile) invece di trascrivere la voce."""
    lines: list[Line] = []
    synced = False
    record = None
    if text is not None:
        lines = parse_plain(text)
    else:
        on_progress(0.02, "Cerco il testo online…")
        record = fetch_lrclib(artist, title, duration)
        if not record and fallback:
            log.info("Testo non trovato online: risincronizzo quello già in libreria")
            text = fallback
            lines = parse_plain(text)
    if record:
        if record.get("syncedLyrics"):
            lines, synced = parse_lrc(record["syncedLyrics"]), True
        if not lines and record.get("plainLyrics"):
            lines = parse_plain(record["plainLyrics"])

    on_progress(0.08, "Ascolto la voce per sincronizzare le parole…")
    audio = _load_16k(vocals)
    voiced = voice_activity(audio)
    # con un testo si ascolta tutta la voce nella sua lingua (vedi transcribe)
    hint = guess_language(lines) if lines else None
    sung_segments, language = _cached_transcription(
        vocals, audio, lambda p: on_progress(0.08 + 0.72 * p, "Sincronizzo le parole…"), language=hint, vad=not lines
    )
    # Giapponese: testo e voce in romaji diviso in parole, così si confrontano e si colorano parola per parola
    ja_text = any(romaji.is_japanese(l.text) for l in lines)
    if ja_text or language == "ja":
        if romanize_lines(lines):
            log.info("Testo giapponese convertito in romaji")
        sung_segments = romanize_sung(sung_segments)
    sung = [w for seg in sung_segments for w in seg]

    if lines and sung:
        if synced:
            # Con i tempi di LRCLIB come punti fermi; se il video è un'altra versione (più lenta, dal
            # vivo, con pause diverse) quei tempi ingannano: si prova anche seguendo solo l'ordine
            # delle parole, come per un testo scritto a mano, e si tiene l'abbinamento migliore.
            import copy

            plain = copy.deepcopy(lines)
            for l in plain:
                l.lrc_time = None
            ratio = align(lines, sung, duration)
            ratio_plain = align(plain, sung, duration)
            # si confronta il risultato (parole che cadono dove si sentono), non le parole abbinate:
            # con i tempi di LRCLIB le righe che il video non canta si tolgono e la quota scende
            if placed_ratio(plain, sung) > placed_ratio(lines, sung) + 0.1:
                log.info("Testo di LRCLIB con tempi di un'altra versione: seguo l'ordine delle parole")
                lines, ratio = plain, ratio_plain
        else:
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
            extend_to_voice(lines, voiced, sung)
            fix_held_notes(lines, voiced, sung, language)
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
        extend_to_voice(lines, voiced, sung)
        return to_json(lines, "whisper", language)
    if lines:
        _distribute([w for l in lines for w in l.words], 0, duration)
        return to_json(lines, "lrclib-unsynced", language)
    return {"source": "none", "language": language, "lines": []}
