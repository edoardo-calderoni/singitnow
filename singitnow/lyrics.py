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
import re
import statistics
import threading
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Callable

import httpx

from . import config

log = logging.getLogger(__name__)

LRCLIB = "https://lrclib.net/api"


@dataclass
class Word:
    text: str
    start: float = -1.0
    end: float = -1.0
    onset: bool = False  # Whisper l'ha sentita attaccare dopo una pausa (tempo d'inizio affidabile)


@dataclass
class Line:
    words: list[Word]
    lrc_time: float | None = None  # tempo LRC originale (se disponibile)
    anchor: float | None = None  # inizio della riga nel video (tempo LRC corretto dallo scarto locale)

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
                device="cpu",
                compute_type="int8",
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
    """Allinea le parole del testo alle parole cantate. Restituisce la frazione di parole abbinate."""
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
            matched += 1
    ratio = matched / max(len(flat), 1)

    if lines and all(l.lrc_time is not None for l in lines):
        _anchor_to_lrc(lines)
    _interpolate(flat, duration)
    return ratio


def _anchor_to_lrc(lines: list[Line]) -> None:
    """Usa i tempi per riga di LRCLIB come punti fermi.

    Whisper tende ad attribuire la pausa prima di una frase alla prima parola (che così "parte"
    anche secondi in anticipo) e a volte abbina parole a ripetizioni sbagliate del ritornello.
    Il tempo LRC, corretto con lo scarto locale rispetto al video, dice quando la riga inizia davvero.
    """
    raw = [l.words[0].start - l.lrc_time if l.words[0].start >= 0 else None for l in lines]
    known = [d for d in raw if d is not None]
    global_off = statistics.median(known) if known else 0.0
    # scarti molto diversi dal resto sono abbinamenti a una ripetizione sbagliata del ritornello
    raw = [d if d is not None and abs(d - global_off) <= 2.5 else None for d in raw]
    # Le righe che Whisper ha sentito attaccare dopo una pausa danno lo scarto più affidabile:
    # nelle altre la prima parola ingloba la pausa e risulta in anticipo.
    clean = [d if d is not None and l.words[0].onset else None for d, l in zip(raw, lines)]
    clean_known = [d for d in clean if d is not None]
    if len(clean_known) >= 3:
        global_off = statistics.median(clean_known)
    starts = []
    for i in range(len(lines)):
        # scarto locale: robusto a video con intro diverse o tagli rispetto alla versione album
        near = [d for d in clean[max(0, i - 8) : i + 9] if d is not None]
        if len(near) < 3:
            near = [d for d in raw[max(0, i - 4) : i + 5] if d is not None]
            near = [d - (statistics.median(known) - global_off) for d in near] if len(clean_known) >= 3 else near
        starts.append(lines[i].lrc_time + (statistics.median(near) if len(near) >= 3 else global_off))

    for i, l in enumerate(lines):
        n = len(l.words)
        L = l.anchor = starts[i]
        R = starts[i + 1] if i + 1 < len(lines) else L + 0.6 * n + 2
        R = max(R, L + 0.25 * n)
        # abbinamenti fuori dalla finestra della riga: sono ripetizioni sbagliate (es. ritornelli)
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
        cleaned = [_clean(w.text) for w in words]
        text = " " + " ".join(cleaned)
        # posizione (in caratteri) di ogni parola del testo, per ritrovarle dopo la tokenizzazione
        spans, pos = [], 1
        for c in cleaned:
            spans.append((pos, pos + len(c)))
            pos += len(c) + 1

        chunk = audio[int(w0 * sr) : int(w1 * sr)]
        with _whisper_lock:
            features = model.feature_extractor(chunk)
            num_frames = features.shape[-1]
            encoder_output = model.encode(pad_or_trim(features))
            result = model.find_alignment(tokenizer, [tokenizer.encode(text)], encoder_output, num_frames)
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


def voice_activity(audio, sr: int = 16000):
    """Per ogni blocco da 20 ms: True se nella traccia vocale isolata qualcuno sta cantando."""
    import numpy as np

    n = int(sr * _HOP)
    frames = audio[: len(audio) // n * n].reshape(-1, n)
    db = 20 * np.log10(np.sqrt((frames**2).mean(axis=1)) + 1e-9)
    # soglia relativa al volume del brano: 28 dB sotto i passaggi più forti
    return db > max(float(np.percentile(db, 95)) - 28, -50)


def snap_to_voice(lines: list[Line], voiced) -> int:
    """Nessuna parola inizia nel silenzio: sposta l'inizio al primo istante in cui la voce c'è davvero.

    Whisper tende ad attribuire la pausa prima di una frase alla prima parola, che così si colora
    prima che il cantante attacchi. Restituisce il numero di parole corrette.
    """
    import numpy as np

    fixed = 0
    probe = int(0.12 / _HOP)
    for l in lines:
        for w in l.words:
            a, b = int(w.start / _HOP), int(w.end / _HOP)
            if b - a < 2 or voiced[a : a + probe].any():
                continue
            on = np.flatnonzero(voiced[a:b])
            if on.size:
                w.start = min((a + on[0]) * _HOP, w.end - 0.08)
                fixed += 1
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
        out.append(
            {
                "start": round(l.words[0].start, 3),
                "end": round(l.words[-1].end, 3),
                "text": l.text,
                "words": [{"t": w.text, "s": round(w.start, 3), "e": round(w.end, 3)} for w in l.words],
            }
        )
    return {"source": source, "language": language, "lines": out}


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
    vocals: Path, artist: str, title: str, duration: float, on_progress: Callable[[float, str], None]
) -> dict:
    on_progress(0.02, "Cerco il testo online…")
    record = fetch_lrclib(artist, title, duration)
    lines: list[Line] = []
    synced = False
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
    sung = [w for seg in sung_segments for w in seg]

    if lines and sung:
        ratio = align(lines, sung, duration)
        log.info("Allineamento testo: %.0f%% parole abbinate", ratio * 100)
        if ratio >= 0.3:
            # Rifinitura: Whisper allinea il testo esatto alla voce, parola per parola.
            on_progress(0.82, "Allineo ogni parola alla voce…")
            try:
                n = force_align(lines, audio, language)
                log.info("Allineamento forzato: %d parole", n)
            except Exception:
                log.exception("Allineamento forzato non riuscito: uso i tempi stimati")
            clamp_line_starts(lines)
            snap_to_voice(lines, voiced)
            return to_json(lines, "lrclib+whisper", language)
    if lines and synced:
        # Allineamento scarso (es. lingua non riconosciuta): tempi per riga di LRCLIB.
        for i, l in enumerate(lines):
            nxt = lines[i + 1].lrc_time if i + 1 < len(lines) else (l.lrc_time or 0) + 5
            _distribute(l.words, l.lrc_time or 0, min(nxt or 0, (l.lrc_time or 0) + 0.5 * len(l.words) + 1))
        return to_json(lines, "lrclib", language)
    if sung_segments:
        lines = [Line(part) for seg in sung_segments for part in _split_long(seg)]
        snap_to_voice(lines, voiced)
        return to_json(lines, "whisper", language)
    if lines:
        _distribute([w for l in lines for w in l.words], 0, duration)
        return to_json(lines, "lrclib-unsynced", language)
    return {"source": "none", "language": language, "lines": []}
