"""Modalità Competizione: classifica della sessione con la media dei voti d'intonazione.

- Si attiva con l'interruttore «Competizione» (sotto Karaoke/Jukebox, sul PC o dai Settaggi
  degli amministratori). L'impostazione resta salvata.
- Una sessione inizia quando parte un brano a musica ferma e finisce quando la musica si ferma del
  tutto (coda finita, Stop, X). A inizio di una nuova sessione la classifica si svuota; quella
  della sessione appena finita resta consultabile fino ad allora.
- Contano solo i brani con un cantante: chi canta più brani ha come punteggio la media aritmetica
  dei suoi voti (non la somma).
- A fine sessione la TV festeggia il vincitore (evento "competition_end").
"""

from __future__ import annotations

import json
import threading
import time

from . import config
from .events import hub

END_DELAY = 2.0  # s a musica ferma prima di chiudere la sessione (un voto può arrivare un attimo dopo)

_lock = threading.RLock()
_results: list[dict] = []  # {singer, song_id, title, score, t}
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
            p["songs"].append({"song_id": r["song_id"], "title": r["title"], "score": r["score"]})
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
        return {"enabled": enabled(), "active": _active, "standings": standings()}


def _publish() -> None:
    hub.publish("competition", public())


def add_score(singer: str, song_id: str, title: str, score: int, entry_id: str = "") -> int | None:
    """Voto di fine brano: entra in classifica solo in competizione e con il nome di chi canta
    (non conta il brano che stava suonando quando la competizione è stata accesa).
    Restituisce la posizione in classifica di chi ha cantato (None se il voto non conta)."""
    singer = singer.strip()
    if not singer or not enabled() or (entry_id and entry_id == _excluded):
        return None
    with _lock:
        _results.append({"singer": singer, "song_id": song_id, "title": title, "score": score, "t": time.time()})
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
    _publish()
