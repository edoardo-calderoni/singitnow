"""La serata: quello che succede da quando si apre l'app, salvato su disco per ripartire dopo un crash.

Partecipanti, voti della serata, competizione ed esibizioni (per le statistiche di fine serata)
vivono in memoria nei rispettivi moduli; ognuno si registra qui con una funzione che restituisce i
suoi dati e una che li rimette a posto. Dopo ogni modifica (`changed()`) il tutto si scrive in
data/party.json entro un secondo; all'avvio, se l'ultimo salvataggio è di meno di PARTY_TTL ore
fa, la serata riprende com'era (l'app si era chiusa a metà festa). Più vecchia: è un'altra serata.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Callable

from . import config

log = logging.getLogger(__name__)

PARTY_TTL = 8 * 3600  # s: oltre, al riavvio si comincia una serata nuova
SAVE_DELAY = 1.0  # s: le modifiche ravvicinate si scrivono insieme

_lock = threading.Lock()
_sections: dict[str, tuple[Callable[[], Any], Callable[[Any], None]]] = {}
_timer: threading.Timer | None = None
_started = time.time()  # inizio della serata (ripreso dal file se la serata continua)


def _path():
    return config.DATA_DIR / "party.json"


def register(name: str, dump: Callable[[], Any], load: Callable[[Any], None]) -> None:
    """Un modulo affida alla serata i suoi dati: dump() li restituisce (serializzabili in JSON),
    load(dati) li rimette a posto al riavvio."""
    _sections[name] = (dump, load)


def started() -> float:
    return _started


def changed() -> None:
    """Qualcosa della serata è cambiato: lo si salva fra poco (una sola scrittura per più modifiche)."""
    global _timer
    with _lock:
        if _timer is not None:
            return
        _timer = threading.Timer(SAVE_DELAY, save)
        _timer.daemon = True
        _timer.start()


def save() -> None:
    global _timer
    with _lock:
        _timer = None
        data: dict[str, Any] = {"saved_at": time.time(), "started": _started}
        for name, (dump, _) in _sections.items():
            try:
                data[name] = dump()
            except Exception:
                log.exception("Serata: salvataggio di %s", name)
        try:
            tmp = _path().with_suffix(".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            tmp.replace(_path())
        except OSError:
            log.exception("Serata: salvataggio non riuscito")


def restore(now: float | None = None) -> bool:
    """All'avvio: riprende la serata salvata se è recente. Restituisce True se l'ha ripresa."""
    global _started
    now = time.time() if now is None else now
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(data, dict) or now - float(data.get("saved_at", 0)) > PARTY_TTL:
        return False
    _started = float(data.get("started") or now)
    for name, (_, load) in _sections.items():
        if name in data:
            try:
                load(data[name])
            except Exception:
                log.exception("Serata: ripristino di %s", name)
    log.info("Serata ripresa (salvata %d minuti fa)", (now - float(data["saved_at"])) / 60)
    return True


def reset() -> None:
    """Nuova serata (dai test o da un comando esplicito): niente da riprendere."""
    global _started
    _started = time.time()
    _path().unlink(missing_ok=True)
