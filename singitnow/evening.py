"""Fine della serata, decisa da un amministratore.

La serata (classifica della competizione, statistiche) non finisce più quando la musica si ferma:
la chiude un amministratore con «Concludi la serata». Da quel momento tutti sanno che il prossimo
brano è l'ultimo (se non c'è niente in coda, l'ultimo è quello che suona); finito quello la musica
si ferma, la TV festeggia il vincitore e mostra le statistiche, i telefoni aprono il riepilogo.

Dopo la fine la musica non riparte da sola (nemmeno se qualcuno aggiunge un brano): quando un
amministratore la riavvia comincia una serata nuova, con classifica e statistiche vuote.
"""

from __future__ import annotations

import logging
import threading

from . import competition, party, stats
from .events import hub

log = logging.getLogger(__name__)

_lock = threading.RLock()
_closing = False  # «Concludi la serata» premuto: si aspetta la fine dell'ultimo brano
_last: str | None = None  # voce della playlist che chiude la serata
_ended = False  # serata conclusa: la musica non riparte da sola


def public() -> dict:
    with _lock:
        return {"closing": _closing, "last_entry": _last, "ended": _ended}


def _publish() -> None:
    hub.publish("evening", public())
    party.changed()


def closing() -> bool:
    return _closing


def ended() -> bool:
    return _ended


def is_last(entry_id: str | None) -> bool:
    """La voce `entry_id` è l'ultimo brano della serata (finita lei, si chiude)."""
    with _lock:
        return bool(_closing and entry_id and entry_id == _last)


def close(playing: str | None, upcoming: list[str]) -> bool:
    """«Concludi la serata»: l'ultimo brano è il primo in coda (o quello che suona, se la coda è
    vuota). Restituisce True se la serata si è chiusa subito (niente che suona e coda vuota)."""
    global _closing, _last
    with _lock:
        last = upcoming[0] if playing and upcoming else playing or (upcoming[0] if upcoming else None)
        if last is None:
            finish_now = True
        else:
            _closing, _last = True, last
            finish_now = False
    if finish_now:
        finish()
        return True
    log.info("Serata in chiusura: l'ultimo brano è %s", last)
    _publish()
    return False


def cancel() -> None:
    """Ci si è ripensati: la serata continua."""
    global _closing, _last
    with _lock:
        if not _closing:
            return
        _closing, _last = False, None
    _publish()


def on_started(entry_id: str, upcoming: list[str]) -> None:
    """Parte un brano. Dopo una serata conclusa ne comincia una nuova; in chiusura, se l'ultimo
    brano previsto non c'è più (tolto dalla coda, saltato), l'ultimo diventa questo."""
    global _ended, _last
    new_evening = moved = False
    with _lock:
        if _ended:
            _ended = False
            new_evening = True
        if _closing and _last != entry_id and _last not in upcoming:
            _last = entry_id
            moved = True
    if new_evening:
        stats.reset()  # la classifica si svuota da sola: la competizione apre una sessione nuova
        log.info("Comincia una serata nuova")
    if new_evening or moved:
        _publish()


def finish() -> None:
    """Fine dell'ultimo brano: si chiude la serata (vincitore, statistiche)."""
    global _closing, _last, _ended
    with _lock:
        _closing, _last, _ended = False, None, True
    competition.finish()  # festeggia il vincitore («competition_end»)
    log.info("Serata conclusa")
    _publish()
    hub.publish("evening_end", {"stats": bool(stats.summary().get("performances"))})


def _dump() -> dict:
    with _lock:
        return {"closing": _closing, "last": _last, "ended": _ended}


def _load(data: dict) -> None:
    global _closing, _last, _ended
    with _lock:
        _closing = bool(data.get("closing")) and bool(data.get("last"))
        _last = data.get("last") if _closing else None
        _ended = bool(data.get("ended"))


def reset() -> None:
    """Per i test: nessuna chiusura in corso."""
    global _closing, _last, _ended
    with _lock:
        _closing, _last, _ended = False, None, False


party.register("evening", _dump, _load)
