"""Griglia del ritmo di un brano, per mixare «in battuta» in modalità DJ.

Dalla base strumentale (batteria e basso senza la voce) si stimano i colpi (beat tracking di
librosa) e se ne ricava una griglia regolare: periodo costante (60 / BPM) e fase, come fanno i
programmi da DJ. La griglia permette di sapere dove cade ogni battito, anche fra quelli rilevati.
Si stima anche il primo tempo della battuta (il «downbeat», in 4/4): fra le quattro posizioni
possibili, quella dove le basse frequenze (cassa e basso) colpiscono più forte.

Il tempo di un brano non è mai perfettamente uguale dall'inizio alla fine (e il beat tracking può
saltare di mezzo battito in un ponte): per il mix servono solo l'inizio del brano che entra e la
fine di quello che esce, quindi si calcolano due griglie locali, sui primi e sugli ultimi 40 s.

Si salvano anche inizio e fine dell'audio udibile (base e voce insieme: un'intro a cappella non è
silenzio), così il mix salta i lunghi silenzi all'inizio e alla fine dei brani.

beats.json: {"version", "start", "end", "intro": griglia, "outro": griglia}
- start / end: primo e ultimo istante (s) in cui il brano si sente
- intro / outro: null se il ritmo non si riconosce
griglia: {"first", "period", "bpm", "count", "downbeat", "steady", "err"}
- first: istante (s) del primo battito; il battito i cade a first + i * period
- count: battiti della griglia
- downbeat: indice (0..3) del primo battito che è un primo tempo di battuta
- steady: i colpi stanno sulla griglia (err = scarto medio, in frazioni di battito); se è False
  il mix non adatta la velocità
"""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

VERSION = 2  # se cambia, la griglia dei brani già in libreria viene ricalcolata all'avvio
SR = 22050
HOP = 256
STEADY_MAX_ERR = 0.12  # scarto medio dei colpi dalla griglia (frazione del periodo) per dirla regolare

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _load(path: Path) -> np.ndarray:
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    out = subprocess.run(cmd, capture_output=True, creationflags=_NO_WINDOW)
    if out.returncode != 0:
        raise RuntimeError(f"ffmpeg: {out.stderr.decode(errors='ignore')[-300:]}")
    return np.frombuffer(out.stdout, dtype=np.float32)


WINDOW = 40.0  # s di colpi usati per la griglia dell'inizio e della fine del brano


def _grid(times: np.ndarray, low: np.ndarray) -> dict | None:
    """Griglia regolare (periodo costante) che segue meglio i colpi `times` di un tratto di brano.
    low: forza di cassa e basso su ogni colpo, per trovare il primo tempo della battuta."""
    if len(times) < 12:
        return None
    # tempo come lo segue il tracker (niente raddoppi o dimezzamenti: il mix gestisce i rapporti 2:1)
    period = float(np.median(np.diff(times)))
    # indice di battito di ogni colpo: passo per passo, così un colpo mancato non sposta gli altri
    steps = np.maximum(1, np.round(np.diff(times) / period))
    idx = np.concatenate([[0], np.cumsum(steps)])
    slope, icpt = np.polyfit(idx, times, 1)
    if 0.97 < slope / period < 1.03:
        period = float(slope)
    else:
        icpt = float(np.median(times - idx * period))
    res = times - (icpt + idx * period)
    err = float(np.mean(np.abs(res)) / period)
    count = int(idx[-1]) + 1
    # primo tempo della battuta: fra le 4 posizioni, quella dove cassa e basso colpiscono più forte
    sums = [low[idx % 4 == k].mean() if np.any(idx % 4 == k) else 0 for k in range(4)]
    return {
        "first": round(float(icpt), 4),
        "period": round(period, 6),
        "bpm": round(60.0 / period, 3),
        "count": count,
        "downbeat": int(np.argmax(sums)),
        "steady": err < STEADY_MAX_ERR,
        "err": round(err, 3),
    }


def extract(audio: Path) -> dict | None:
    import librosa

    y = _load(audio)
    if len(y) < SR * 10:
        return None
    onset = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP, aggregate=np.median)
    _, frames = librosa.beat.beat_track(onset_envelope=onset, sr=SR, hop_length=HOP, start_bpm=120, units="frames")
    # ogni colpo agganciato al picco d'attacco più vicino (entro ~35 ms): il tracker è un po' «tremolante»
    reach = 3
    frames = np.array([max(0, f - reach) + int(np.argmax(onset[max(0, f - reach) : f + reach + 1])) for f in frames])
    times = librosa.frames_to_time(frames, sr=SR, hop_length=HOP)
    if len(times) < 24:
        return None
    # forza delle basse frequenze (sotto i 150 Hz) su ogni colpo
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
    lowenv = librosa.onset.onset_strength(S=librosa.amplitude_to_db(S[freqs < 150]), sr=SR, hop_length=HOP)
    low = lowenv[np.clip(frames, 0, len(lowenv) - 1)]

    head = times < times[0] + WINDOW
    tail = times > times[-1] - WINDOW
    return {"intro": _grid(times[head], low[head]), "outro": _grid(times[tail], low[tail])}


SILENCE_DB = -45.0  # sotto questo livello (rispetto al punto più forte del brano) è silenzio
SILENCE_HOP = 0.05  # s


def audible(paths: list[Path]) -> tuple[float, float] | None:
    """Primo e ultimo istante in cui il brano si sente (tracce sommate: base e voce)."""
    ys = [_load(p) for p in paths if p.exists()]
    if not ys:
        return None
    n = min(len(y) for y in ys)
    y = np.sum([y[:n] for y in ys], axis=0)
    hop = int(SR * SILENCE_HOP)
    frames = len(y) // hop
    if frames < 2:
        return None
    rms = np.sqrt(np.mean(y[: frames * hop].reshape(frames, hop) ** 2, axis=1)) + 1e-9
    db = 20 * np.log10(rms / rms.max())
    loud = np.flatnonzero(db > SILENCE_DB)
    if not len(loud):
        return None
    return round(float(loud[0] * SILENCE_HOP), 2), round(float((loud[-1] + 1) * SILENCE_HOP), 2)


def is_current(song_dir: Path) -> bool:
    try:
        return json.loads((song_dir / "beats.json").read_text(encoding="utf-8")).get("version") == VERSION
    except (OSError, ValueError):
        return False


def build(song_dir: Path) -> bool:
    """Crea beats.json dalla base strumentale. False se non è stato possibile."""
    src = song_dir / "instrumental.m4a"
    if not src.exists():
        return False
    # brano senza un ritmo riconoscibile: si salva comunque, così non lo si riprova a ogni avvio
    data = {"version": VERSION, "start": 0.0, "end": 0.0, "intro": None, "outro": None}
    data.update(extract(src) or {})
    bounds = audible([src, song_dir / "vocals.m4a"])
    if bounds:
        data["start"], data["end"] = bounds
    (song_dir / "beats.json").write_text(json.dumps(data), encoding="utf-8")
    return True
