"""Profili delle persone, da una serata all'altra: foto, brani cantati e record personale.

L'identità è nome e cognome scritti sul telefono (le stesse due parole = la stessa persona). Ogni
esibizione finisce in data/profiles/history.json (con il voto d'intonazione, se c'è); la foto si
tiene anche legata a nome e cognome, così chi torna un'altra sera la ritrova anche se nel frattempo
il nome con cui è chiamato è cambiato («Marco» / «Marco R.»). Il record personale guarda anche i voti
della Hall of Fame salvati prima che esistessero i profili.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time

from . import config, halloffame

log = logging.getLogger(__name__)

_lock = threading.Lock()
RECENT = 20  # brani mostrati nello storico


def _dir():
    d = config.DATA_DIR / "profiles"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _key(first: str, last: str) -> str:
    return f"{' '.join(first.split()).casefold()}|{' '.join(last.split()).casefold()}"


def _photo(first: str, last: str):
    return _dir() / (hashlib.sha1(_key(first, last).encode("utf-8")).hexdigest()[:20] + ".jpg")


def _history_path():
    return _dir() / "history.json"


def _read() -> list[dict]:
    try:
        data = json.loads(_history_path().read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _write(data: list[dict]) -> None:
    try:
        tmp = _history_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(_history_path())
    except OSError:
        log.exception("Salvataggio dello storico dei profili non riuscito")


# ------------------------------------------------------------------ foto
def save_photo(first: str, last: str, data: bytes) -> None:
    if first.strip():
        _photo(first, last).write_bytes(data)


def remove_photo(first: str, last: str) -> None:
    if first.strip():
        _photo(first, last).unlink(missing_ok=True)


def photo(first: str, last: str) -> bytes | None:
    p = _photo(first, last)
    return p.read_bytes() if first.strip() and p.exists() else None


# ------------------------------------------------------------------ esibizioni
def performed(first: str, last: str, entry_id: str, song_id: str, title: str, artist: str, partner: str = "") -> None:
    """Questa persona ha cantato (o è partita a cantare) un brano."""
    if not first.strip():
        return
    with _lock:
        data = _read()
        k = _key(first, last)
        if any(r.get("entry") == entry_id and r.get("key") == k for r in data):
            return
        data.append({
            "key": k, "first": first, "last": last, "entry": entry_id, "song_id": song_id,
            "title": title, "artist": artist, "partner": partner, "t": time.time(), "score": None,
        })
        _write(data)


def scored(first: str, last: str, entry_id: str, score: int) -> None:
    """Voto d'intonazione dell'esibizione (arriva a fine brano)."""
    if not first.strip():
        return
    with _lock:
        data = _read()
        k = _key(first, last)
        for r in reversed(data):
            if r.get("entry") == entry_id and r.get("key") == k:
                r["score"] = score if r.get("score") is None else max(r["score"], score)
                _write(data)
                return


def profile(first: str, last: str) -> dict:
    """Profilo di una persona: esibizioni, record personale, brano preferito e ultimi brani cantati."""
    k = _key(first, last)
    with _lock:
        mine = [r for r in _read() if r.get("key") == k]
    # voti della Hall of Fame (anche di prima dei profili) che non sono già nello storico
    known = {(r["song_id"], round(r["t"])) for r in mine}
    old = [
        r for r in halloffame.rows()
        if _key(r.get("first") or r.get("singer") or "", r.get("last") or "") == k
    ]
    scores = [(r["score"], r["title"], r["song_id"], r["t"]) for r in mine if r.get("score") is not None]
    scores += [(r["score"], r.get("title", ""), r.get("song_id", ""), r["t"]) for r in old
               if (r.get("song_id"), round(r["t"])) not in known]
    best = max(scores, key=lambda s: (s[0], -s[3]), default=None)
    count: dict[str, list] = {}
    for r in mine:
        c = count.setdefault(r["song_id"], [r["title"], 0])
        c[1] += 1
    fav = max(count.values(), key=lambda c: c[1], default=None)
    times = [r["t"] for r in mine] + [s[3] for s in scores]
    return {
        "performances": len(mine),
        "first_seen": min(times) if times else None,
        "best": {"score": best[0], "title": best[1], "song_id": best[2], "t": best[3]} if best else None,
        "favorite": {"title": fav[0], "count": fav[1]} if fav and fav[1] > 1 else None,
        "recent": [
            {"title": r["title"], "artist": r["artist"], "song_id": r["song_id"], "t": r["t"],
             "score": r.get("score"), "partner": r.get("partner", "")}
            for r in sorted(mine, key=lambda r: -r["t"])[:RECENT]
        ],
    }
