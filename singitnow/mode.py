"""Modalità della serata, scelta da un amministratore.

- karaoke: si canta a turno (un brano in coda per persona, voce guida regolabile, applausi);
- jukebox: si ascoltano i brani con la voce originale, ognuno aggiunge quanti brani vuole.
"""

from __future__ import annotations

import json
import threading

from . import config
from .events import hub

KARAOKE = "karaoke"
JUKEBOX = "jukebox"
MODES = (KARAOKE, JUKEBOX)

_lock = threading.Lock()


def _path():
    return config.DATA_DIR / "settings.json"


def _read() -> dict:
    try:
        return json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def get() -> str:
    m = _read().get("mode")
    return m if m in MODES else KARAOKE


def is_jukebox() -> bool:
    return get() == JUKEBOX


def public() -> dict:
    return {"mode": get()}


def set_mode(mode: str) -> dict:
    if mode not in MODES:
        raise ValueError(mode)
    with _lock:
        data = _read()
        data["mode"] = mode
        _path().parent.mkdir(parents=True, exist_ok=True)
        _path().write_text(json.dumps(data), encoding="utf-8")
    hub.publish("mode", public())
    return public()
