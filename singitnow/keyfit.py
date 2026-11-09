"""Tonalità consigliata: l'estensione della voce di ogni persona e la trasposizione più comoda di un brano.

Mentre si canta (in Karaoke, da soli) il player misura le note cantate davvero e a fine brano manda
il riassunto: nota bassa, centrale e alta (5°, 50° e 95° percentile). Si tengono le ultime
esibizioni di ogni persona (data/profiles/voice.json, per nome e cognome, come i profili).

Per un brano si confronta la melodia (pitch.json) con l'estensione della persona e si sceglie lo
spostamento, fra -KEY_RANGE e +KEY_RANGE semitoni, che la fa stare meglio dentro la voce. Cantare
un'ottava sopra o sotto va bene lo stesso (uomini e donne cantano gli stessi brani), quindi conta
solo quanto la melodia esce dall'estensione nell'ottava più comoda. Se la tonalità originale va già
bene (o il guadagno è minimo) il consiglio è 0.
"""

from __future__ import annotations

import json
import logging
import threading
import time

import numpy as np

from . import audio, config
from .library import library

log = logging.getLogger(__name__)

_lock = threading.Lock()
KEEP = 10  # esibizioni ricordate per persona
MIN_SECONDS = 15.0  # s di voce misurata perché un'esibizione conti
MIN_GAIN = 0.35  # semitoni medi fuori dalla voce risparmiati: sotto, si resta nella tonalità originale
CENTER_WEIGHT = 0.15  # peso della distanza fra il centro della melodia e quello della voce
SHIFT_COST = 0.04  # a parità, meglio spostare poco


def _path():
    d = config.DATA_DIR / "profiles"
    d.mkdir(parents=True, exist_ok=True)
    return d / "voice.json"


def _key(first: str, last: str) -> str:
    return f"{' '.join(first.split()).casefold()}|{' '.join(last.split()).casefold()}"


def _read() -> dict:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def add(first: str, last: str, lo: float, mid: float, hi: float, seconds: float, song_id: str = "") -> bool:
    """Estensione misurata in un'esibizione. False se è troppo breve o poco credibile."""
    if not first.strip() or seconds < MIN_SECONDS:
        return False
    if not (30 <= lo <= mid <= hi <= 96) or hi - lo < 2:
        return False
    with _lock:
        data = _read()
        rows = data.setdefault(_key(first, last), [])
        rows.append({"lo": round(lo, 2), "mid": round(mid, 2), "hi": round(hi, 2), "s": round(seconds, 1),
                     "song_id": song_id, "t": time.time()})
        del rows[:-KEEP]
        try:
            tmp = _path().with_suffix(".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            tmp.replace(_path())
        except OSError:
            log.exception("Salvataggio dell'estensione della voce non riuscito")
            return False
    _cache.clear()
    return True


def voice(first: str, last: str) -> dict | None:
    """Estensione abituale (mediana delle ultime esibizioni), None se non c'è ancora."""
    if not first.strip():
        return None
    with _lock:
        rows = _read().get(_key(first, last)) or []
    if not rows:
        return None
    med = lambda k: float(np.median([r[k] for r in rows]))  # noqa: E731
    return {"lo": med("lo"), "mid": med("mid"), "hi": med("hi"), "count": len(rows)}


# ------------------------------------------------------------------ melodia del brano
_melodies: dict[str, tuple[float, np.ndarray, np.ndarray]] = {}


def _melody(song_id: str) -> tuple[np.ndarray, np.ndarray] | None:
    """Note sicure della melodia (MIDI) e la loro durata, da pitch.json."""
    song = library.get(song_id)
    if not song:
        return None
    p = song.dir / "pitch.json"
    try:
        mtime = p.stat().st_mtime
    except OSError:
        return None
    hit = _melodies.get(song_id)
    if hit and hit[0] == mtime:
        return hit[1], hit[2]
    try:
        notes = json.loads(p.read_text(encoding="utf-8")).get("notes") or []
    except (OSError, ValueError):
        return None
    sure = [n for n in notes if len(n) >= 3 and not (len(n) > 3 and n[3]) and n[1] > n[0]]
    if len(sure) < 8:
        return None
    midi = np.array([n[2] for n in sure], dtype=float)
    dur = np.array([n[1] - n[0] for n in sure], dtype=float)
    _melodies[song_id] = (mtime, midi, dur)
    return midi, dur


def _wmedian(x: np.ndarray, w: np.ndarray) -> float:
    o = np.argsort(x)
    c = np.cumsum(w[o])
    return float(x[o][np.searchsorted(c, c[-1] / 2)])


def best_shift(midi: np.ndarray, dur: np.ndarray, v: dict, key_range: int = audio.KEY_RANGE) -> int:
    """Spostamento in semitoni che fa stare meglio la melodia nella voce `v` (0 = va bene così)."""
    lo, hi, mid = v["lo"], v["hi"], v["mid"]
    w = dur / dur.sum()
    center = _wmedian(midi, w)

    def cost(k: int) -> float:
        best = np.inf
        for o in (-24, -12, 0, 12, 24):
            x = midi + k + o
            out = np.maximum(0.0, lo - x) + np.maximum(0.0, x - hi)
            c = float((out * w).sum()) + CENTER_WEIGHT * abs(center + k + o - mid)
            best = min(best, c)
        return best

    costs = {k: cost(k) + SHIFT_COST * abs(k) for k in range(-key_range, key_range + 1)}
    k = min(costs, key=costs.get)
    return k if k != 0 and costs[0] - costs[k] >= MIN_GAIN else 0


_cache: dict[tuple[str, str], int | None] = {}


def suggest(song_id: str, first: str, last: str) -> int | None:
    """Tonalità consigliata a questa persona per questo brano: None se non si sa (voce o melodia mancanti)."""
    ck = (song_id, _key(first, last))
    if ck in _cache:
        return _cache[ck]
    v = voice(first, last)
    mel = _melody(song_id) if v else None
    k = best_shift(*mel, v) if v and mel else None
    _cache[ck] = k
    return k


_prepared: set[tuple[str, int]] = set()


def prepare(song_id: str, semitones: int) -> None:
    """Prepara in sottofondo base e voce guida nella tonalità indicata (così il brano parte subito)."""
    song = library.get(song_id)
    if not song or not semitones or (song_id, semitones) in _prepared:
        return
    _prepared.add((song_id, semitones))

    def work():
        for name in ("instrumental.m4a", "vocals.m4a"):
            src = song.dir / name
            if src.exists():
                try:
                    audio.transposed(src, semitones, voice=name == "vocals.m4a")
                except Exception:
                    log.exception("Preparazione della tonalità %+d non riuscita", semitones)

    threading.Thread(target=work, daemon=True, name="keyfit-prepare").start()
