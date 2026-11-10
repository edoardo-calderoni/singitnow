"""Brani con problemi: controllo della libreria per i Settaggi dell'app sul PC.

Per ogni brano si guarda:
- importazione non riuscita o file mancanti (video, base, voce);
- testo mancante;
- testo fuori tempo: quante parole del testo (di almeno 3 lettere) si sentono davvero nella voce,
  vicino al momento in cui compaiono (dalla trascrizione salvata, whisper.json). Quasi nessuna =
  testo tutto fuori tempo (di solito un testo di LRCLIB che non si è riusciti ad allineare);
- testo trascritto automaticamente (non trovato online): può avere parole sbagliate;
- note dell'intonazione mancanti (in Competizione il brano non ha voto);
- ritmo mancante (niente mix in battuta in DJ e Jukebox).

Un problema si può «ignorare» (data/health_ignore.json): non compare più finché il brano non cambia.
"""

from __future__ import annotations

import bisect
import json
import threading

from . import config
from .library import ERROR, READY, library
from .lyrics import _norm, _similar, full_transcription

ERR, WARN, INFO = "error", "warn", "info"
_LEVEL = {ERR: 0, WARN: 1, INFO: 2}
OFF = 0.15  # parole sentite al loro posto: sotto, testo tutto fuori tempo
PARTIAL = 0.45  # sotto, fuori tempo in alcuni punti
UNHEARD = 0.5  # parole riconosciute nella voce rispetto a quelle del testo: sotto, la verifica non vale
NEAR = 1.5  # s: distanza massima fra la parola del testo e quella sentita
MIN_NOTES = 20

_lock = threading.Lock()
_cache: dict[str, tuple[tuple, list[dict]]] = {}


def _read(path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _mtime(path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def heard_ratio(lyrics: dict, whisper: dict) -> tuple[float, float] | None:
    """(quota delle parole del testo che si sentono nella voce vicino al momento in cui compaiono,
    parole riconosciute nella voce rispetto a quelle del testo). None se il testo non ha parole."""
    sung = sorted(
        (w[1], _norm(w[0])) for seg in whisper.get("segments") or [] for w in seg if len(w) >= 3 and _norm(w[0])
    )
    times = [t for t, _ in sung]
    ok = tot = 0
    for line in lyrics.get("lines") or []:
        for w in line.get("words") or []:
            n = _norm(w.get("t", ""))
            if len(n) < 3:
                continue
            tot += 1
            s = w.get("s", 0.0)
            lo, hi = bisect.bisect_left(times, s - NEAR), bisect.bisect_right(times, s + NEAR)
            if any(_similar(n, sung[i][1]) > 0 for i in range(lo, hi)):
                ok += 1
    return (ok / tot, len(sung) / tot) if tot else None


def check(song) -> list[dict]:
    """Problemi di un brano: [{code, level, text}]."""
    d = song.dir
    key = (song.status, song.error, *(_mtime(d / f) for f in ("lyrics.json", "whisper.json", "pitch.json", "beats.json", "video.mp4", "instrumental.m4a", "vocals.m4a")))
    hit = _cache.get(song.id)
    if hit and hit[0] == key:
        return hit[1]
    out: list[dict] = []

    def add(code: str, level: str, text: str):
        out.append({"code": code, "level": level, "text": text})

    if song.status == ERROR:
        add("import", ERR, f"Importazione non riuscita{': ' + song.error if song.error else ''}")
    elif song.status == READY:
        missing = [n for n, f in (("video", "video.mp4"), ("base", "instrumental.m4a"), ("voce", "vocals.m4a")) if not (d / f).exists()]
        if missing:
            add("files", ERR, f"Mancano dei file ({', '.join(missing)}): va reimportato")
        lyrics = _read(d / "lyrics.json")
        lines = (lyrics or {}).get("lines") or []
        if not lines:
            add("lyrics_missing", ERR, "Manca il testo")
        else:
            whisper = _read(d / "whisper.json")
            res = heard_ratio(lyrics, whisper) if whisper else None
            ratio, coverage = res if res else (None, 0.0)
            if ratio is not None and ratio < PARTIAL and coverage < UNHEARD:
                # la voce non è stata riconosciuta (lingua sbagliata, voce coperta): non si può dire
                add("lyrics_unverified", WARN, "Non riesco a verificare il testo: la voce è stata riconosciuta poco, il testo potrebbe essere fuori tempo")
            elif ratio is not None and ratio < OFF:
                add("lyrics_off", ERR, f"Testo fuori tempo: solo il {round(ratio * 100)}% delle parole si sente quando compare")
            elif ratio is not None and ratio < PARTIAL:
                add("lyrics_partial", WARN, f"Testo fuori tempo in alcuni punti: si sente il {round(ratio * 100)}% delle parole quando compare")
            if (lyrics or {}).get("source") == "whisper":
                add("lyrics_auto", INFO, "Testo trascritto automaticamente dalla voce (non trovato online): può avere parole sbagliate")
        pitch = _read(d / "pitch.json")
        sure = [n for n in (pitch or {}).get("notes") or [] if not (len(n) > 3 and n[3])]
        if len(sure) < MIN_NOTES:
            add("pitch", WARN, "Mancano le note dell'intonazione: in Competizione il brano non ha voto")
        if not (d / "beats.json").exists():
            add("beats", INFO, "Manca il ritmo: in DJ e Jukebox niente mix in battuta")
    _cache[song.id] = (key, out)
    return out


# ------------------------------------------------------------------ problemi ignorati
def _ignore_path():
    return config.DATA_DIR / "health_ignore.json"


def _ignored() -> dict[str, dict[str, list]]:
    data = _read(_ignore_path())
    return data if isinstance(data, dict) else {}


def ignore(song_id: str, code: str) -> None:
    """Non segnalare più questo problema di questo brano (finché il brano non cambia)."""
    song = library.get(song_id)
    if not song:
        return
    with _lock:
        data = _ignored()
        data.setdefault(song_id, {})[code] = list(_cache.get(song_id, ((),))[0])
        _ignore_path().write_text(json.dumps(data), encoding="utf-8")


REPAIRABLE = ("lyrics_off", "lyrics_partial", "lyrics_unverified")


def report(repairing: list[str] | None = None) -> dict:
    """Brani con problemi. `repairing`: brani in riparazione (si mostrano anche se ora non hanno problemi)."""
    ignored = _ignored()
    repairing = repairing or []
    songs = []
    for s in library.all():
        if s.id in repairing:
            p = s.to_public()
            songs.append({
                "id": s.id, "title": s.title, "artist": s.artist, "status": s.status,
                "thumbnail_url": p.get("thumbnail_url"), "issues": [], "repairing": True,
                "queued": repairing.index(s.id), "repaired": False,
            })
            continue
        issues = check(s)
        key = list(_cache.get(s.id, ((),))[0])
        skip = ignored.get(s.id, {})
        issues = [i for i in issues if skip.get(i["code"]) != key]
        if not issues:
            continue
        p = s.to_public()
        songs.append({
            "id": s.id, "title": s.title, "artist": s.artist, "status": s.status,
            "thumbnail_url": p.get("thumbnail_url"), "issues": issues, "repairing": False,
            # riparabile in automatico finché la voce non è stata riascoltata tutta
            "repaired": full_transcription(s.dir),
        })

    def level(x):
        return min((_LEVEL[i["level"]] for i in x["issues"]), default=-1)

    songs.sort(key=lambda x: (level(x), x["title"].casefold()))
    count = {lvl: sum(1 for x in songs if level(x) == _LEVEL[lvl]) for lvl in _LEVEL}
    return {"songs": songs, "total": len(library.all()), "count": count, "repairing": len(repairing)}
