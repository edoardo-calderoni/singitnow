"""Modalità della serata, scelta da un amministratore.

- karaoke: si canta a turno (un brano in coda per persona, voce guida regolabile, applausi);
- jukebox: si ascoltano i brani con la voce originale, ognuno aggiunge quanti brani vuole;
- dj: come jukebox, ma aggiungono brani solo il DJ della serata (eletto dal PC o da un
  amministratore), gli amministratori e il PC.
"""

from __future__ import annotations

import json
import threading
import time

from . import config
from .events import hub

KARAOKE = "karaoke"
JUKEBOX = "jukebox"
DJ = "dj"
MODES = (KARAOKE, JUKEBOX, DJ)

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
    """Si ascolta con la voce originale (Jukebox e DJ): niente canto, applausi né limite di brani."""
    return get() in (JUKEBOX, DJ)


def dj() -> str:
    """Nome del DJ della serata ("" se non è ancora stato eletto)."""
    return str(_read().get("dj", "") or "")


def is_dj(name: str) -> bool:
    d = dj().strip().casefold()
    return bool(d) and name.strip().casefold() == d


def public() -> dict:
    # dj_at: istante dell'elezione (il telefono del DJ mostra l'avviso una volta per elezione)
    return {"mode": get(), "dj": dj(), "dj_at": int(_read().get("dj_at", 0) or 0)}


def set_dj(name: str) -> dict:
    with _lock:
        data = _read()
        name = name.strip()[:40]
        if name != data.get("dj"):
            data["dj_at"] = int(time.time() * 1000)
        data["dj"] = name
        _path().parent.mkdir(parents=True, exist_ok=True)
        _path().write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    hub.publish("mode", public())
    return public()


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


# ------------------------------------------------------------------ riproduzione automatica
def autoplay() -> bool:
    """Settaggio «Riproduzione automatica»: la playlist ferma parte da sola quando un utente
    aggiunge un brano dal telefono (dal PC si usa sempre «Avvia playlist»). Acceso di default."""
    return bool(_read().get("autoplay", True))


def locked() -> bool:
    """Settaggio «Blocca inserimenti e richieste»: nessuno aggiunge o chiede brani (neanche il DJ) e
    la playlist la gestiscono solo gli amministratori e il PC. Spento di default."""
    return bool(_read().get("locked", False))


def record() -> bool:
    """Settaggio «Registra le esibizioni»: il player registra voce e base di chi canta, che poi la
    scarica dal telefono. Acceso di default (sulla TV si vede «REC» mentre registra)."""
    return bool(_read().get("record", True))


def auto_key() -> bool:
    """Settaggio «Adatta la tonalità automaticamente»: in Karaoke ogni brano parte nella tonalità
    consigliata a chi lo canta (se il sistema conosce la sua voce). Spento di default."""
    return bool(_read().get("auto_key", False))


def quiz() -> bool:
    """Settaggio «Quiz musicale»: in Karaoke, fra un brano e l'altro, un quiz sui brani della libreria.
    Spento di default."""
    return bool(_read().get("quiz", False))


def settings_public() -> dict:
    return {"autoplay": autoplay(), "locked": locked(), "record": record(), "auto_key": auto_key(), "quiz": quiz()}


def _set(key: str, value) -> dict:
    with _lock:
        data = _read()
        data[key] = value
        _path().parent.mkdir(parents=True, exist_ok=True)
        _path().write_text(json.dumps(data), encoding="utf-8")
    hub.publish("settings", settings_public())  # PC e telefoni si aggiornano
    return settings_public()


def set_autoplay(enabled: bool) -> dict:
    return _set("autoplay", bool(enabled))


def set_locked(enabled: bool) -> dict:
    return _set("locked", bool(enabled))


def set_record(enabled: bool) -> dict:
    return _set("record", bool(enabled))


def set_auto_key(enabled: bool) -> dict:
    return _set("auto_key", bool(enabled))


def set_quiz(enabled: bool) -> dict:
    return _set("quiz", bool(enabled))


def rename_dj(old: str, new: str) -> None:
    """Il DJ della serata cambia nome (omonimo arrivato): resta DJ."""
    if dj().strip().casefold() == old.strip().casefold():
        with _lock:
            data = _read()
            data["dj"] = new
            _path().write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        hub.publish("mode", public())
