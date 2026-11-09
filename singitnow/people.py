"""Persone della festa: nome e cognome di chi entra dal telefono, e il nome con cui chiamarle.

Nella festa ognuno è chiamato solo con il nome. Se due persone diverse hanno lo stesso nome
(cognomi diversi) diventano «Marco R.» e «Marco B.»; se anche l'iniziale coincide si aggiungono
lettere del cognome fino a distinguerle («Marco Ro.» e «Marco Ru.»).

La festa è fatta da chi è entrato da quando l'app è aperta (anche se ora è scollegato): così i nomi
non cambiano ogni volta che qualcuno perde il Wi-Fi. Quando il nome mostrato di qualcuno cambia
(è arrivato un omonimo) lo si rinomina ovunque: coda, voti, competizione, foto, DJ (vedi on_rename).
"""

from __future__ import annotations

import logging
import threading
from typing import Callable

from . import party
from .events import hub

log = logging.getLogger(__name__)

_lock = threading.RLock()
_people: dict[str, tuple[str, str]] = {}  # chiave -> (nome, cognome)
_display: dict[str, str] = {}  # chiave -> nome mostrato
_renamers: list[Callable[[str, str], None]] = []


def clean(s: str) -> str:
    return " ".join((s or "").split())[:30]


def _key(first: str, last: str) -> str:
    return f"{clean(first).casefold()}|{clean(last).casefold()}"


def short_names(people: list[tuple[str, str]]) -> dict[tuple[str, str], str]:
    """Nome mostrato per ogni (nome, cognome): solo il nome, oppure con l'iniziale del cognome (o
    più lettere) se c'è un'altra persona con lo stesso nome. Usata anche per la Hall of Fame."""
    groups: dict[str, list[tuple[str, str]]] = {}
    for p in dict.fromkeys(people):  # senza doppioni, in ordine
        groups.setdefault(p[0].casefold(), []).append(p)
    out: dict[tuple[str, str], str] = {}
    for group in groups.values():
        distinct = {p[1].casefold() for p in group}
        if len(group) == 1 or len(distinct) == 1:
            for p in group:
                out[p] = p[0]
            continue
        for p in group:
            first, last = p
            if not last:
                out[p] = first
                continue
            n = 1
            # quante lettere del cognome servono per distinguerlo dagli omonimi
            while n < len(last) and any(
                q[1][:n].casefold() == last[:n].casefold() and q[1].casefold() != last.casefold() for q in group
            ):
                n += 1
            out[p] = f"{first} {last[:n].upper() if n == 1 else last[:1].upper() + last[1:n].lower()}."
    return out


def on_rename(cb: Callable[[str, str], None]) -> None:
    """cb(vecchio, nuovo): chiamata quando il nome mostrato di qualcuno cambia."""
    _renamers.append(cb)


def join(first: str, last: str) -> str:
    """Qualcuno entra (o si ricollega) dal telefono: restituisce il nome con cui chiamarlo."""
    first, last = clean(first), clean(last)
    if not first:
        return ""
    k = _key(first, last)
    with _lock:
        _people[k] = (first, last)
        names = short_names(list(_people.values()))
        new = {key: names[p] for key, p in _people.items()}
        changed = [(_display[key], new[key]) for key in _display if key in new and _display[key] != new[key]]
        _display.clear()
        _display.update(new)
        mine = new[k]
    for old, now in changed:
        log.info("Omonimi: %s diventa %s", old, now)
        for cb in _renamers:
            try:
                cb(old, now)
            except Exception:
                log.exception("Rinomina %s -> %s", old, now)
    hub.publish("people", public())
    party.changed()
    return mine


def display_of(first: str, last: str) -> str:
    """Nome con cui è chiamato nella festa chi ha questo nome e cognome ("" se non è entrato)."""
    with _lock:
        return _display.get(_key(first, last), "")


def full_of(display: str) -> tuple[str, str] | None:
    """(nome, cognome) di chi nella festa si chiama `display` (None se non è entrato dal telefono)."""
    d = clean(display).casefold()
    with _lock:
        for k, name in _display.items():
            if name.casefold() == d:
                return _people[k]
    return None


def public() -> list[dict]:
    with _lock:
        return [{"first": p[0], "last": p[1], "name": _display[k]} for k, p in _people.items()]


def _dump() -> list[list[str]]:
    with _lock:
        return [list(p) for p in _people.values()]


def _load(data: list) -> None:
    """Riavvio a metà serata: chi era entrato resta nella festa, con lo stesso nome («Marco R.»)."""
    with _lock:
        for first, last in data:
            first, last = clean(first), clean(last)
            if first:
                _people[_key(first, last)] = (first, last)
        names = short_names(list(_people.values()))
        _display.clear()
        _display.update({k: names[p] for k, p in _people.items()})


party.register("people", _dump, _load)
