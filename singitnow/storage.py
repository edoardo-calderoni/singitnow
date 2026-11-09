"""Spazio su disco: quanto occupa ogni brano e cosa si può liberare.

Per ogni brano: video, tracce (base e voce), tonalità trasposte (cartella keys/, si rigenerano da
sole in una decina di secondi se servono di nuovo) e il resto (testo, copertina, note…). In più il
totale delle registrazioni, dei modelli AI e lo spazio libero sul disco.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from . import config, halloffame
from .library import library

AUDIO = {"instrumental.m4a", "vocals.m4a"}


def _size(p: Path) -> int:
    if p.is_file():
        return p.stat().st_size
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.is_dir() else 0


def _song_sizes(d: Path) -> dict[str, int]:
    out = {"video": 0, "audio": 0, "keys": 0, "other": 0}
    if not d.is_dir():
        return out
    for f in d.iterdir():
        if f.name == "keys":
            out["keys"] += _size(f)
        elif f.name == "video.mp4":
            out["video"] += _size(f)
        elif f.name in AUDIO:
            out["audio"] += _size(f)
        else:
            out["other"] += _size(f)
    return out


def report() -> dict:
    """Occupazione della libreria brano per brano (dal più grande) e totali."""
    sung = {r.get("song_id") for r in halloffame.rows()}
    songs = []
    for s in library.all():
        sizes = _song_sizes(s.dir)
        songs.append({
            "id": s.id, "title": s.title, "artist": s.artist, "status": s.status,
            "played_at": s.played_at, "never_played": not s.played_at and s.id not in sung,
            "sizes": sizes, "total": sum(sizes.values()),
        })
    songs.sort(key=lambda x: -x["total"])
    disk = shutil.disk_usage(config.DATA_DIR)
    return {
        "songs": songs,
        "library": sum(x["total"] for x in songs),
        "keys": sum(x["sizes"]["keys"] for x in songs),
        "recordings": _size(config.DATA_DIR / "recordings"),
        "models": _size(config.MODELS_DIR),
        "work": _size(config.WORK_DIR),
        "free": disk.free,
        "disk": disk.total,
    }


def clear_keys(song_id: str | None = None) -> int:
    """Elimina le tonalità trasposte (di un brano o di tutti). Restituisce i byte liberati."""
    freed = 0
    for s in library.all():
        if song_id and s.id != song_id:
            continue
        k = s.dir / "keys"
        if k.is_dir():
            freed += _size(k)
            shutil.rmtree(k, ignore_errors=True)
    return freed


def clear_work() -> int:
    """Residui di elaborazioni interrotte (cartella work/ dei brani non in elaborazione)."""
    from .pipeline import pipeline

    freed = 0
    if config.WORK_DIR.is_dir():
        for d in config.WORK_DIR.iterdir():
            if d.name != pipeline._current:
                freed += _size(d)
                shutil.rmtree(d, ignore_errors=True)
    return freed
