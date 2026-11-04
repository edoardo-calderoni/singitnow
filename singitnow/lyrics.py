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


@dataclass
class Line:
    words: list[Word]
    lrc_time: float | None = None  # tempo LRC originale (se disponibile)

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


def transcribe(vocals: Path, on_progress: Callable[[float], None]) -> tuple[list[list[Word]], str]:
    """Trascrive la traccia vocale. Restituisce (segmenti di parole con tempi, lingua)."""
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
        segments, info = _whisper.transcribe(
            _load_16k(vocals),
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
            src, dst = flat[blk.a + k], sung[blk.b + k]
            src.start, src.end = dst.start, dst.end
            matched += 1
    ratio = matched / max(len(flat), 1)

    # Righe senza alcuna parola abbinata: usa il tempo LRC corretto dallo scarto medio.
    offsets = []
    for l in lines:
        timed = [w for w in l.words if w.start >= 0]
        if l.lrc_time is not None and len(timed) >= max(2, len(l.words) // 2):
            offsets.append(timed[0].start - l.lrc_time)
    offset = statistics.median(offsets) if offsets else None

    for i, l in enumerate(lines):
        if l.lrc_time is not None and offset is not None and all(w.start < 0 for w in l.words):
            start = l.lrc_time + offset
            nxt = lines[i + 1].lrc_time + offset if i + 1 < len(lines) and lines[i + 1].lrc_time is not None else start + 4
            _distribute(l.words, start, min(nxt, start + 0.45 * len(l.words) + 1))

    _interpolate(flat, duration)
    return ratio


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
    sung_segments, language = transcribe(vocals, lambda p: on_progress(0.08 + 0.87 * p, "Sincronizzo le parole…"))
    sung = [w for seg in sung_segments for w in seg]

    if lines and sung:
        ratio = align(lines, sung, duration)
        log.info("Allineamento testo: %.0f%% parole abbinate", ratio * 100)
        if ratio >= 0.3:
            return to_json(lines, "lrclib+whisper", language)
    if lines and synced:
        # Allineamento scarso (es. lingua non riconosciuta): tempi per riga di LRCLIB.
        for i, l in enumerate(lines):
            nxt = lines[i + 1].lrc_time if i + 1 < len(lines) else (l.lrc_time or 0) + 5
            _distribute(l.words, l.lrc_time or 0, min(nxt or 0, (l.lrc_time or 0) + 0.5 * len(l.words) + 1))
        return to_json(lines, "lrclib", language)
    if sung_segments:
        lines = [Line(part) for seg in sung_segments for part in _split_long(seg)]
        return to_json(lines, "whisper", language)
    if lines:
        _distribute([w for l in lines for w in l.words], 0, duration)
        return to_json(lines, "lrclib-unsynced", language)
    return {"source": "none", "language": language, "lines": []}
