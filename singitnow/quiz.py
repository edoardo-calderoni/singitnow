"""Quiz musicale: fra un brano e l'altro (in Karaoke con la Competizione accesa, se acceso nei
Settaggi) una domanda sui brani della libreria, a cui si risponde dal telefono.

1. intro (7 s): sulla TV la scritta del quiz con il conto alla rovescia;
2. question: la TV fa sentire un pezzo di un brano della libreria (solo l'audio) e sui telefoni
   compaiono tre risposte. Le domande: titolo, chi la canta, anno di uscita, oppure la parola che
   viene subito dopo il pezzo ascoltato (il pezzo si ferma lì). Vale la prima risposta di ognuno;
   appena qualcuno risponde giusto la domanda si chiude;
3. reveal (7 s): le risposte di tutti, e chi ha indovinato festeggiato;
4. ranking (7 s): la classifica, poi riparte la musica.

Punti: chi indovina guadagna +2 sulla media della Competizione (al massimo +6 per sessione: il quiz
aiuta ma non ribalta la classifica del canto).
"""

from __future__ import annotations

import json
import logging
import random
import re
import threading
import time
import unicodedata

from . import competition, covers, mode, party, people
from .events import hub
from .library import READY, library

log = logging.getLogger(__name__)

INTRO = 7.0
CLIP = 20.0  # titolo, artista, anno: si risponde mentre il pezzo suona
WORD_CLIP = 12.0  # parola successiva: il pezzo si ferma prima della parola…
WORD_ANSWER = 10.0  # …e poi c'è ancora un po' di tempo per rispondere
REVEAL = 7.0
RANKING = 7.0
RECENT = 15  # brani usati di recente: per un po' non tornano

QUESTIONS = {
    "title": "Come si intitola questo brano?",
    "artist": "Chi canta questo brano?",
    "year": "In che anno è uscito questo brano?",
    "next_word": "Qual è la parola che viene subito dopo?",
}

_lock = threading.RLock()
_state: dict | None = None
_timer: threading.Timer | None = None
_recent: list[str] = []
_tally: dict[str, dict] = {}  # risposte esatte della serata: casefold(nome) -> {"name", "points"}


def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.casefold())
    return "".join(ch for ch in text if ch.isalnum())


# ------------------------------------------------------------------ domande
def _lines(song) -> list[dict]:
    try:
        return json.loads((song.dir / "lyrics.json").read_text(encoding="utf-8")).get("lines") or []
    except (OSError, ValueError):
        return []


def _clip_start(song, lines: list[dict]) -> float:
    """Inizio del pezzo da far sentire: una riga cantata nella parte centrale del brano."""
    dur = song.duration or 180
    mid = [l for l in lines if dur * 0.25 <= l.get("start", 0) <= dur * 0.7 and l.get("text", "").strip()]
    if mid:
        return max(0.0, random.choice(mid)["start"] - 1.5)
    return dur * random.uniform(0.3, 0.55)


def _three(correct: str, pool: list[str]) -> tuple[list[str], int] | None:
    """La risposta giusta e due sbagliate (diverse fra loro), in ordine casuale."""
    seen = {_norm(correct)}
    wrong = []
    for x in random.sample(pool, len(pool)):
        n = _norm(x)
        if n and n not in seen:
            seen.add(n)
            wrong.append(x)
            if len(wrong) == 2:
                break
    if len(wrong) < 2:
        return None
    options = [correct, *wrong]
    random.shuffle(options)
    return options, options.index(correct)


def _years(correct: int, pool: list[int]) -> list[str]:
    """Due anni sbagliati ben distinti (dagli altri brani, altrimenti vicini a quello giusto)."""
    now = time.localtime().tm_year
    out: list[int] = []
    for y in random.sample(pool, len(pool)) + [correct + d for d in random.sample([-9, -7, -5, -4, -3, 3, 4, 5, 7, 9], 10)]:
        if 1950 <= y <= now and all(abs(y - z) >= 3 for z in [correct, *out]):
            out.append(y)
            if len(out) == 2:
                break
    return [str(y) for y in out]


def _next_word(song, lines: list[dict], pool_words: list[str]) -> dict | None:
    """Domanda sulla parola che viene dopo: l'ultima parola di una riga (spesso fa rima)."""
    cands = []
    for l in lines:
        words = l.get("words") or []
        if len(words) < 3:
            continue
        w = words[-1]
        text = re.sub(r"[^\w']", "", w.get("t", ""), flags=re.UNICODE).strip("'")
        if len(text) >= 3 and text.isalpha() and w.get("s", 0) >= 15:
            cands.append((w["s"], text))
    ends = [w for _, w in cands]  # le altre parole di fine riga: plausibili quanto quella giusta
    random.shuffle(cands)
    for start, word in cands:
        similar = [p.lower() for p in pool_words if len(p) >= 4 and abs(len(p) - len(word)) <= 3]
        picked = _three(word.lower(), [e.lower() for e in ends]) or _three(word.lower(), similar)
        if not picked:
            continue
        end = start - 0.12
        return {"options": picked[0], "correct": picked[1], "clip": {"start": max(0.0, end - WORD_CLIP), "end": end}}
    return None


def _question(exclude: set[str]) -> dict | None:
    songs = [
        s for s in library.all()
        if s.status == READY and s.title.strip() and (s.dir / "video.mp4").exists()
    ]
    if len(songs) < 3:
        return None
    titles = [s.title for s in songs]
    artists = list({_norm(s.artist): s.artist for s in songs if s.artist.strip()}.values())
    years = [s.year for s in songs if s.year > 0]
    fresh = [s for s in songs if s.id not in exclude and s.id not in _recent] or [s for s in songs if s.id not in exclude]
    random.shuffle(fresh)
    for song in fresh:
        lines = _lines(song)
        kinds = ["title", "artist", "year", "next_word"]
        random.shuffle(kinds)
        for kind in kinds:
            q: dict | None = None
            if kind == "title":
                picked = _three(song.title, [t for t in titles if t != song.title])
                q = picked and {"options": picked[0], "correct": picked[1]}
            elif kind == "artist" and song.artist.strip():
                picked = _three(song.artist, [a for a in artists if _norm(a) != _norm(song.artist)])
                q = picked and {"options": picked[0], "correct": picked[1]}
            elif kind == "year" and song.year > 0:
                wrong = _years(song.year, [y for y in years if y != song.year])
                if len(wrong) == 2:
                    options = [str(song.year), *wrong]
                    random.shuffle(options)
                    q = {"options": options, "correct": options.index(str(song.year))}
            elif kind == "next_word" and lines:
                words = {
                    re.sub(r"[^\w']", "", w.get("t", ""), flags=re.UNICODE).strip("'")
                    for l in lines for w in (l.get("words") or [])
                }
                q = _next_word(song, lines, [w for w in words if len(w) >= 3 and w.isalpha()])
            if q:
                if "clip" not in q:
                    start = _clip_start(song, lines)
                    q["clip"] = {"start": start, "end": min(song.duration or start + CLIP, start + CLIP)}
                answer_time = WORD_CLIP + WORD_ANSWER if kind == "next_word" else CLIP
                return {"kind": kind, "question": QUESTIONS[kind], "song_id": song.id, "answer_time": answer_time, **q}
    return None


# ------------------------------------------------------------------ stato
def _ranking() -> dict:
    """Classifica da mostrare dopo la domanda: quella della Competizione."""
    rows = competition.standings()
    return {"kind": "competition", "rows": [{"name": r["singer"], "value": r["average"], "quiz": r.get("quiz", 0)} for r in rows[:8]]}


def public() -> dict:
    with _lock:
        s = _state
        if not s:
            return {"phase": None}
        out = {
            "id": s["id"],
            "phase": s["phase"],
            "kind": s["kind"],
            "question": s["question"],
            "options": s["options"],
            "remaining": max(0.0, s["deadline"] - time.time()),
            "clip": s["clip"],
            "answered": [a["name"] for a in s["answers"].values()],
        }
        if s["phase"] in ("reveal", "ranking"):
            song = library.get(s["song_id"])
            out |= {
                "correct": s["correct"],
                "answers": [{"name": a["name"], "choice": a["choice"]} for a in s["answers"].values()],
                "winner": s["winner"],
                "points": s["points"],
                "song": {
                    "title": song.title, "artist": song.artist, "year": song.year if song.year > 0 else None,
                    "thumbnail_url": song.to_public().get("thumbnail_url"),
                } if song else None,
            }
        if s["phase"] == "ranking":
            out["ranking"] = s["ranking"]
        return out


def _publish() -> None:
    hub.publish("quiz", public())


def _go(phase: str, seconds: float) -> None:
    """Passa alla fase `phase` per `seconds` secondi (da chiamare col lock)."""
    global _timer
    s = _state
    assert s is not None
    s["phase"] = phase
    s["deadline"] = time.time() + seconds
    if _timer:
        _timer.cancel()
    _timer = threading.Timer(seconds, _advance, args=(s["id"], phase))
    _timer.daemon = True
    _timer.start()


def _advance(qid: str, phase: str) -> None:
    global _state, _timer
    with _lock:
        s = _state
        if not s or s["id"] != qid or s["phase"] != phase:
            return
        if phase == "intro":
            _go("question", s["answer_time"])
        elif phase == "question":
            _go("reveal", REVEAL)
        elif phase == "reveal":
            s["ranking"] = _ranking()
            _go("ranking", RANKING)
        else:
            _state = None
            _timer = None
    _publish()


def start(after_entry: str, exclude: set[str] | None = None) -> bool:
    """Fra un brano (`after_entry`, appena finito) e il successivo. False se il quiz non si fa:
    spento, Competizione spenta, non in Karaoke, nessuno collegato dal telefono o troppo pochi brani."""
    global _state
    if not mode.quiz() or not competition.enabled() or mode.is_jukebox() or not people.public():
        return False
    with _lock:
        if _state:
            return False
        q = _question(exclude or set())
        if not q:
            return False
        _state = q | {
            "id": f"{time.time():.3f}", "after": after_entry, "answers": {}, "winner": None, "points": 0,
            "phase": "intro", "deadline": 0.0,
        }
        _recent.append(q["song_id"])
        del _recent[:-RECENT]
        _go("intro", INTRO)
    _publish()
    fill_years()  # la prossima volta anche le domande sull'anno, se mancano ancora degli anni
    return True


def answer(name: str, choice: int) -> str:
    """Risposta dal telefono. Restituisce "" se va bene, altrimenti il motivo."""
    name = name.strip()[:40]
    if not name:
        return "Serve il tuo nome"
    with _lock:
        s = _state
        if not s or s["phase"] != "question":
            return "Non c'è una domanda aperta"
        k = name.casefold()
        if k in s["answers"]:
            return "Hai già risposto"
        if not 0 <= choice < len(s["options"]):
            return "Risposta non valida"
        s["answers"][k] = {"name": name, "choice": choice, "t": time.time()}
        if choice == s["correct"]:
            s["winner"] = name
            s["points"] = competition.quiz_point(name)
            t = _tally.setdefault(k, {"name": name, "points": 0})
            t["points"] += 1
            party.changed()
            _go("reveal", REVEAL)
    _publish()
    return ""


def cancel() -> None:
    global _state, _timer
    with _lock:
        if not _state:
            return
        _state = None
        if _timer:
            _timer.cancel()
            _timer = None
    _publish()


def on_playlist(now_playing: str | None) -> None:
    """La musica è cambiata (Stop, Avanti, un altro brano avviato): il quiz in corso si chiude."""
    s = _state
    if s and now_playing != s["after"]:
        cancel()


def clip_path():
    """File del brano del quiz in corso (solo l'audio viene suonato dalla TV)."""
    s = _state
    song = library.get(s["song_id"]) if s else None
    return song.dir / "video.mp4" if song else None


# ------------------------------------------------------------------ serata
def _dump() -> dict:
    with _lock:
        return {"tally": dict(_tally)}


def _load(data: dict) -> None:
    with _lock:
        _tally.clear()
        _tally.update({k: v for k, v in (data.get("tally") or {}).items() if isinstance(v, dict)})


party.register("quiz", _dump, _load)


# ------------------------------------------------------------------ anno di uscita
_filling = threading.Lock()


def fill_years() -> None:
    """In sottofondo: cerca su iTunes l'anno di uscita dei brani che non l'hanno ancora."""

    def run():
        if not _filling.acquire(blocking=False):
            return
        try:
            for s in library.all():
                if s.status == READY and s.year == 0:
                    y = covers.find_year(s.artist, s.title)
                    library.update(s.id, year=y or -1)
                    time.sleep(0.3)
        except Exception:
            log.exception("Ricerca dell'anno dei brani non riuscita")
        finally:
            _filling.release()

    threading.Thread(target=run, name="quiz-anni", daemon=True).start()
