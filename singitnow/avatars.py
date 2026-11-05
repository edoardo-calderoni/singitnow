"""Foto profilo dei partecipanti (scattate o scelte dal telefono), salvate sul PC in data/avatars/."""

from __future__ import annotations

import hashlib
import json
import threading
import time

from . import config
from .events import hub

MAX_BYTES = 1_500_000  # il telefono le riduce già a 320×320 (poche decine di KB)
_lock = threading.Lock()


def _dir():
    d = config.DATA_DIR / "avatars"
    d.mkdir(parents=True, exist_ok=True)
    return d


def key(name: str) -> str:
    """Stesso nome a meno di maiuscole/spazi = stessa persona."""
    return " ".join(name.split()).lower()


def _file(name: str):
    return _dir() / (hashlib.sha1(key(name).encode("utf-8")).hexdigest()[:20] + ".jpg")


def _index_path():
    return _dir() / "index.json"


def _read_index() -> dict[str, int]:
    try:
        return json.loads(_index_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def public_map() -> dict[str, str]:
    """nome normalizzato -> URL della foto (con versione, così i client vedono subito le modifiche)."""
    from urllib.parse import quote

    return {k: f"/api/avatars/{quote(k)}?v={v}" for k, v in _read_index().items()}


def save(name: str, data: bytes) -> None:
    if not key(name):
        raise ValueError("Nome mancante")
    if len(data) > MAX_BYTES:
        raise ValueError("Foto troppo grande")
    if not data.startswith(b"\xff\xd8"):
        raise ValueError("La foto deve essere un JPEG")
    with _lock:
        _file(name).write_bytes(data)
        index = _read_index()
        index[key(name)] = int(time.time() * 1000)
        _index_path().write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    hub.publish("avatars", public_map())


def remove(name: str) -> None:
    with _lock:
        _file(name).unlink(missing_ok=True)
        index = _read_index()
        index.pop(key(name), None)
        _index_path().write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    hub.publish("avatars", public_map())


def path(name: str):
    p = _file(name)
    return p if p.exists() else None
