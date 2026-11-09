"""Statistiche della serata: chi ha cantato cosa, gli applausi e i voti di ogni esibizione.

Ogni brano che parte con un cantante è un'esibizione. Il riepilogo di fine serata (summary) dice
il brano più applaudito, la miglior intonazione, il duetto migliore e chi ha cantato di più. I dati
fanno parte della serata (party): dopo un riavvio a metà festa ci sono ancora.
"""

from __future__ import annotations

import threading
import time

from . import party, people, profiles

_lock = threading.RLock()
# esibizioni: {id, song_id, title, artist, singer, partner, t, applause, scores: {cantante: voto}}
_shows: list[dict] = []


def _find(entry_id: str) -> dict | None:
    return next((s for s in reversed(_shows) if s["id"] == entry_id), None)


def _full(name: str) -> tuple[str, str]:
    """(nome, cognome) di chi nella festa si chiama `name` (solo il nome se è stato aggiunto dal PC)."""
    return people.full_of(name) or (name, "")


def started(entry_id: str, song_id: str, title: str, artist: str, singer: str, partner: str = "") -> None:
    """È partito un brano. Conta come esibizione solo con chi canta (non in Jukebox o senza nome).
    Finisce anche nello storico del profilo di chi canta (e di chi si è unito nel duetto)."""
    if not singer.strip():
        return
    with _lock:
        if _find(entry_id):
            return
        _shows.append({
            "id": entry_id, "song_id": song_id, "title": title, "artist": artist,
            "singer": singer.strip(), "partner": partner.strip(), "t": time.time(),
            "applause": 0, "scores": {},
        })
    party.changed()
    for me, other in ((singer, partner), (partner, singer)):
        if me.strip():
            profiles.performed(*_full(me.strip()), entry_id, song_id, title, artist, other.strip())


def applause(entry_id: str) -> None:
    with _lock:
        s = _find(entry_id)
        if s:
            s["applause"] += 1
    party.changed()


def score(entry_id: str, singer: str, value: int) -> None:
    """Voto d'intonazione di fine brano (con due microfoni ne arriva uno per cantante)."""
    with _lock:
        s = _find(entry_id)
        if s and singer.strip():
            s["scores"][singer.strip()] = int(value)
    party.changed()
    if singer.strip():
        profiles.scored(*_full(singer.strip()), entry_id, int(value))


def rename(old: str, new: str) -> None:
    o = old.casefold()
    with _lock:
        for s in _shows:
            for k in ("singer", "partner"):
                if s[k].casefold() == o:
                    s[k] = new
            for name in [n for n in s["scores"] if n.casefold() == o]:
                s["scores"][new] = s["scores"].pop(name)
    party.changed()


def _performers(s: dict) -> list[str]:
    return [n for n in (s["singer"], s["partner"]) if n]


def _show(s: dict) -> dict:
    return {
        "song_id": s["song_id"], "title": s["title"], "artist": s["artist"],
        "singers": _performers(s), "applause": s["applause"],
        "score": max(s["scores"].values()) if s["scores"] else None,
    }


def summary() -> dict:
    """Riepilogo della serata (le voci senza dati sono None)."""
    with _lock:
        shows = [dict(s, scores=dict(s["scores"])) for s in _shows]
    applauded = max((s for s in shows if s["applause"]), key=lambda s: (s["applause"], -s["t"]), default=None)

    best_pitch = None
    for s in shows:
        for name, v in s["scores"].items():
            if best_pitch is None or v > best_pitch["score"]:
                best_pitch = {"singer": name, "score": v, "title": s["title"], "song_id": s["song_id"]}

    duets = [s for s in shows if s["partner"]]

    def duet_rank(s: dict) -> tuple:
        sc = list(s["scores"].values())
        return (sum(sc) / len(sc) if sc else -1, s["applause"])

    best_duet = max(duets, key=duet_rank, default=None)

    count: dict[str, list] = {}  # chi -> [nome, esibizioni, primo brano]
    for s in shows:
        for name in _performers(s):
            c = count.setdefault(name.casefold(), [name, 0, s["t"]])
            c[1] += 1
    most = max(count.values(), key=lambda c: (c[1], -c[2]), default=None)
    top = [c[0] for c in count.values() if most and c[1] == most[1]]

    return {
        "started": party.started(),
        "now": time.time(),
        "performances": len(shows),
        "singers": len(count),
        "applause": sum(s["applause"] for s in shows),
        "most_applauded": _show(applauded) if applauded else None,
        "best_pitch": best_pitch,
        "best_duet": _show(best_duet) if best_duet else None,
        "most_songs": {"singers": top, "count": most[1]} if most else None,
    }


def _load(data: list) -> None:
    with _lock:
        _shows[:] = [s for s in data if isinstance(s, dict) and s.get("id")]
        for s in _shows:
            s.setdefault("applause", 0)
            s.setdefault("scores", {})
            s.setdefault("partner", "")


def reset() -> None:
    with _lock:
        _shows.clear()


party.register("stats", lambda: [dict(s) for s in _shows], _load)
