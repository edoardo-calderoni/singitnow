"""Storico dei voti d'intonazione, salvato su disco (resta anche quando si riavvia l'app).

Serve per la «hall of fame» di ogni brano: i migliori punteggi di sempre su quella canzone, uno per
cantante. Si salvano solo i voti con il nome di chi ha cantato.
"""

from __future__ import annotations

import json
import logging
import threading

from . import config
from .people import short_names

log = logging.getLogger(__name__)

_lock = threading.Lock()
TOP = 7  # posti mostrati


def _path():
    return config.DATA_DIR / "scores.json"


def _read() -> list[dict]:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def add(first: str, last: str, song_id: str, title: str, score: int, t: float, shown: str = "") -> None:
    """Un voto: con nome e cognome (il cognome manca per chi è stato aggiunto dal PC a mano).
    shown: il nome con cui era chiamato alla festa (la sua foto è salvata con quel nome)."""
    with _lock:
        data = _read()
        data.append(
            {"first": first, "last": last, "singer": shown, "song_id": song_id, "title": title, "score": score, "t": t}
        )
        try:
            tmp = _path().with_suffix(".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            tmp.replace(_path())
        except OSError:
            log.exception("Salvataggio dei voti non riuscito")


def rows() -> list[dict]:
    """Tutti i voti salvati (copia), per i profili delle persone."""
    with _lock:
        return [dict(r) for r in _read()]


def _person(r: dict) -> tuple[str, str]:
    # i voti salvati prima del cognome hanno solo "singer"
    return (r.get("first") or r.get("singer") or "", r.get("last") or "")


def for_song(song_id: str) -> list[dict]:
    """Migliori punteggi di sempre sul brano, uno per persona (il migliore), dal più alto. A pari
    punteggio vince chi l'ha fatto per primo.

    I nomi sono quelli dell'intero archivio: solo il nome, oppure «Marco R.» se nell'archivio ci sono
    altre persone con lo stesso nome (anche se stasera alla festa non ci sono omonimi)."""
    with _lock:
        all_rows = [r for r in _read() if _person(r)[0]]
    names = short_names([_person(r) for r in all_rows])
    best: dict[tuple[str, str], dict] = {}
    for r in all_rows:
        if r.get("song_id") != song_id:
            continue
        p = _person(r)
        k = (p[0].casefold(), p[1].casefold())
        if k not in best or r["score"] > best[k]["score"]:
            best[k] = r
    out = sorted(best.values(), key=lambda r: (-r["score"], r["t"]))[:TOP]
    return [
        {"singer": names[_person(r)], "avatar": r.get("singer") or names[_person(r)], "score": r["score"], "t": r["t"]}
        for r in out
    ]
