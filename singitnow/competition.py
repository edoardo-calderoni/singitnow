"""Modalità Competizione: classifica della sessione con la media dei voti d'intonazione.

- Si attiva con l'interruttore «Competizione» (sotto Karaoke/Jukebox, sul PC o dai Settaggi
  degli amministratori). L'impostazione resta salvata.
- Una sessione inizia quando parte un brano a musica ferma e finisce quando la musica si ferma del
  tutto (coda finita, Stop, X). A inizio di una nuova sessione la classifica si svuota; quella
  della sessione appena finita resta consultabile fino ad allora.
- Contano solo i brani con un cantante: chi canta più brani ha come punteggio la media aritmetica
  dei suoi voti (non la somma).
- A fine sessione la TV festeggia il vincitore (evento "competition_end").
- Voto del pubblico: a fine brano, per VOTE_WINDOW secondi, gli altri partecipanti votano
  l'esibizione dal telefono (da 1 a 5 stelle; chi canta non vota sé stesso). Il punteggio del brano
  diventa per il AUDIENCE_WEIGHT dalla media del pubblico (5 stelle = 100) e per il resto
  dall'intonazione; senza voti resta l'intonazione.
"""

from __future__ import annotations

import json
import threading
import time

from . import config, party
from .events import hub

END_DELAY = 2.0  # s a musica ferma prima di chiudere la sessione (un voto può arrivare un attimo dopo)
VOTE_WINDOW = 40.0  # s per votare un'esibizione dal telefono
AUDIENCE_WEIGHT = 0.3  # peso del pubblico nel punteggio del brano (il resto è l'intonazione)

_lock = threading.RLock()
_results: list[dict] = []  # {singer, song_id, title, score, pitch, t, entry_id}
# voti del pubblico: voce della playlist -> {chi vota (minuscolo): stelle}
_votes: dict[str, dict[str, int]] = {}
# votazione aperta: {entry_id, singers, title, song_id, until} (None se non se ne vota nessuna)
_vote: dict | None = None
_vote_timer: threading.Timer | None = None
_active = False  # sessione in corso
_excluded = ""  # brano (voce della playlist) in corso quando la competizione è stata accesa: non conta
_end_timer: threading.Timer | None = None


def _settings_path():
    return config.DATA_DIR / "settings.json"


def _read_settings() -> dict:
    try:
        return json.loads(_settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def enabled() -> bool:
    """Competizione accesa: lo è di default, finché qualcuno non la spegne."""
    return bool(_read_settings().get("competition", True))


def set_enabled(on: bool, playing_entry: str | None = None) -> dict:
    """Accende o spegne la competizione. Accesa a playlist in corsa (`playing_entry` = brano che sta
    suonando): la classifica riparte vuota e il brano in corso non conta, si parte dal successivo."""
    global _active, _excluded
    with _lock:
        was = enabled()
        data = _read_settings()
        data["competition"] = bool(on)
        _settings_path().parent.mkdir(parents=True, exist_ok=True)
        _settings_path().write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        if on and not was and playing_entry:
            _results.clear()
            _active = True
            _excluded = playing_entry
    _publish()
    return public()


def standings() -> list[dict]:
    """Classifica della sessione: media dei voti di ciascuno, dalla più alta."""
    with _lock:
        people: dict[str, dict] = {}
        for r in _results:
            k = r["singer"].casefold()
            p = people.setdefault(k, {"singer": r["singer"], "songs": [], "first": r["t"]})
            p["songs"].append(
                {"song_id": r["song_id"], "title": r["title"], "score": r["score"],
                 "pitch": r.get("pitch", r["score"]), "audience": r.get("audience"), "votes": r.get("votes", 0)}
            )
        out = []
        for p in people.values():
            scores = [s["score"] for s in p["songs"]]
            avg = sum(scores) / len(scores)
            out.append({"singer": p["singer"], "average": round(avg, 1), "songs": p["songs"], "first": p["first"]})
        # a pari media vince chi ha cantato per primo
        out.sort(key=lambda p: (-p["average"], p["first"]))
        for p in out:
            p.pop("first")
        return out


def public() -> dict:
    with _lock:
        vote = dict(_vote) if _vote and _vote["until"] > time.time() else None
        if vote:
            vote["votes"] = len(_votes.get(vote["entry_id"], {}))
        return {
            "enabled": enabled(),
            "active": _active,
            "standings": standings(),
            "vote": vote,
            "audience_weight": AUDIENCE_WEIGHT,
        }


def combined(pitch: int, stars: list[int]) -> int:
    """Punteggio del brano: intonazione e, se ci sono voti, media del pubblico (5 stelle = 100)."""
    if not stars:
        return pitch
    audience = sum(stars) / len(stars) * 20
    return round((1 - AUDIENCE_WEIGHT) * pitch + AUDIENCE_WEIGHT * audience)


def _rescore(entry_id: str) -> None:
    """Ricalcola il punteggio dei risultati di un'esibizione dopo un voto del pubblico (col lock)."""
    stars = list(_votes.get(entry_id, {}).values())
    for r in _results:
        if r.get("entry_id") == entry_id:
            r["score"] = combined(r.get("pitch", r["score"]), stars)
            r["audience"] = round(sum(stars) / len(stars), 1) if stars else None
            r["votes"] = len(stars)


def _open_vote(entry_id: str, singers: list[str], song_id: str, title: str) -> None:
    """Apre (o allarga, per il secondo cantante di un duetto) la votazione di un'esibizione."""
    global _vote, _vote_timer
    with _lock:
        if _vote and _vote["entry_id"] == entry_id:
            names = {n.casefold() for n in _vote["singers"]}
            _vote["singers"] += [n for n in singers if n.casefold() not in names]
            return
        _vote = {
            "entry_id": entry_id,
            "singers": singers,
            "song_id": song_id,
            "title": title,
            "until": time.time() + VOTE_WINDOW,
        }
        if _vote_timer:
            _vote_timer.cancel()
        _vote_timer = threading.Timer(VOTE_WINDOW + 0.5, _close_vote)
        _vote_timer.daemon = True
        _vote_timer.start()


def _close_vote() -> None:
    global _vote, _vote_timer
    with _lock:
        _vote, _vote_timer = None, None
    _publish()


def vote(entry_id: str, voter: str, stars: int) -> str:
    """Un partecipante vota l'esibizione dal telefono. Restituisce "" se il voto vale, altrimenti
    il motivo. Si può cambiare il proprio voto finché la votazione è aperta."""
    voter = voter.strip()
    with _lock:
        if not _vote or _vote["entry_id"] != entry_id or _vote["until"] < time.time():
            return "La votazione di questa esibizione è chiusa"
        if not voter:
            return "Inserisci il tuo nome per votare"
        if voter.casefold() in {n.casefold() for n in _vote["singers"]}:
            return "Non puoi votare la tua esibizione"
        _votes.setdefault(entry_id, {})[voter.casefold()] = max(1, min(5, int(stars)))
        _rescore(entry_id)
    _publish()
    return ""


def _publish() -> None:
    hub.publish("competition", public())
    party.changed()


def _dump() -> dict:
    with _lock:
        return {"results": list(_results), "votes": _votes}


def _load(data: dict) -> None:
    """Riavvio a metà serata: la classifica della sessione resta consultabile (la musica è ferma,
    quindi la sessione è finita: il prossimo brano ne comincia una nuova)."""
    with _lock:
        _results[:] = [r for r in data.get("results", []) if isinstance(r, dict) and r.get("singer")]
        _votes.clear()
        _votes.update({k: dict(v) for k, v in (data.get("votes") or {}).items() if isinstance(v, dict)})


party.register("competition", _dump, _load)


def add_score(
    singer: str, song_id: str, title: str, score: int, entry_id: str = "", performers: list[str] | None = None
) -> int | None:
    """Voto di fine brano: entra in classifica solo in competizione e con il nome di chi canta
    (non conta il brano che stava suonando quando la competizione è stata accesa).
    Apre la votazione del pubblico per l'esibizione; performers: tutti quelli che l'hanno cantata
    (duetto), che non possono votarla.
    Restituisce la posizione in classifica di chi ha cantato (None se il voto non conta)."""
    singer = singer.strip()
    if not singer or not enabled() or (entry_id and entry_id == _excluded):
        return None
    with _lock:
        _results.append(
            {"singer": singer, "song_id": song_id, "title": title, "score": score, "pitch": score,
             "t": time.time(), "entry_id": entry_id}
        )
        if entry_id:
            _rescore(entry_id)  # voti già arrivati (secondo microfono di un duetto)
            _open_vote(entry_id, [singer, *[p for p in performers or [] if p]], song_id, title)
        table = standings()
    _publish()
    return next((i + 1 for i, p in enumerate(table) if p["singer"].casefold() == singer.casefold()), None)


def on_playing(playing: bool) -> None:
    """Chiamata a ogni cambio della playlist: apre e chiude le sessioni."""
    global _active, _end_timer, _excluded
    with _lock:
        if playing:
            if _end_timer:
                _end_timer.cancel()  # la musica è ripartita subito: stessa sessione
                _end_timer = None
            if not _active:
                _active = True
                _excluded = ""
                _results.clear()  # nuova sessione: classifica vuota
                _votes.clear()
                _publish()
        elif _active and _end_timer is None:
            _end_timer = threading.Timer(END_DELAY, _finish)
            _end_timer.daemon = True
            _end_timer.start()


def _finish() -> None:
    global _active, _end_timer
    with _lock:
        _end_timer = None
        if not _active:
            return
        _active = False
        table = standings()
        celebrate = enabled() and bool(table)
    _publish()
    if celebrate:
        hub.publish("competition_end", {"standings": table})


def rename(old: str, new: str) -> None:
    """Qualcuno cambia nome (omonimo arrivato): i suoi voti della sessione restano suoi."""
    with _lock:
        for r in _results:
            if r["singer"].casefold() == old.casefold():
                r["singer"] = new
        if _vote:
            _vote["singers"] = [new if n.casefold() == old.casefold() else n for n in _vote["singers"]]
        for v in _votes.values():
            if old.casefold() in v:
                v[new.casefold()] = v.pop(old.casefold())
    _publish()
