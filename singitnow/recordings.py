"""Registrazioni delle esibizioni: voce dei microfoni e base, scaricabili dal telefono di chi canta.

Il player della TV registra (nel browser) il microfono insieme alla base e, a fine brano, manda qui
il file (WebM/Opus). Si salva in data/recordings/<id>/ con i dati dell'esibizione e lo si converte
in M4A (AAC), che si apre su tutti i telefoni (anche iPhone). Le vede e le scarica solo chi ha
cantato (anche chi si è unito nel duetto), riconosciuto da nome e cognome. Dopo KEEP_DAYS giorni
si cancellano da sole.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import threading
import time
import uuid

from . import audio, config

log = logging.getLogger(__name__)

KEEP_DAYS = 60
MIN_SECONDS = 45  # registrazioni più corte (brano fermato subito) non si tengono
MAX_BYTES = 200 * 1024 * 1024
_lock = threading.Lock()


def _dir():
    d = config.DATA_DIR / "recordings"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _key(first: str, last: str) -> str:
    return f"{' '.join(first.split()).casefold()}|{' '.join(last.split()).casefold()}"


def _meta(rid: str) -> dict | None:
    try:
        return json.loads((_dir() / rid / "meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save(data: bytes, meta: dict) -> dict:
    """Nuova registrazione. meta: song_id, title, artist, seconds e performers = [(nome, cognome, nome
    mostrato)]. ValueError se è vuota o troppo corta. La conversione in M4A va in background."""
    if not data or len(data) > MAX_BYTES:
        raise ValueError("Registrazione vuota o troppo grande")
    if float(meta.get("seconds") or 0) < MIN_SECONDS:
        raise ValueError("Registrazione troppo corta")
    rid = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    d = _dir() / rid
    d.mkdir(parents=True)
    (d / "rec.webm").write_bytes(data)
    info = {
        "id": rid,
        "t": time.time(),
        "song_id": meta.get("song_id", ""),
        "title": meta.get("title", ""),
        "artist": meta.get("artist", ""),
        "seconds": round(float(meta.get("seconds") or 0)),
        "keys": [_key(f, l) for f, l, _ in meta.get("performers", []) if f],
        "names": [n for _, _, n in meta.get("performers", []) if n],
    }
    (d / "meta.json").write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
    threading.Thread(target=_convert, args=(rid,), name="registrazione", daemon=True).start()
    return info


def _convert(rid: str) -> None:
    d = _dir() / rid
    try:
        audio.ffmpeg("-i", str(d / "rec.webm"), "-vn", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
                     str(d / "rec.m4a"))
        (d / "rec.webm").unlink(missing_ok=True)
    except Exception:
        log.exception("Conversione della registrazione %s", rid)
        (d / "rec.m4a").unlink(missing_ok=True)


def for_person(first: str, last: str) -> list[dict]:
    """Registrazioni in cui ha cantato questa persona, dalla più recente."""
    k = _key(first, last)
    out = []
    for d in _dir().iterdir():
        m = _meta(d.name) if d.is_dir() else None
        if m and k in m.get("keys", []):
            out.append(m | {"ready": (d / "rec.m4a").exists()})
    return sorted(out, key=lambda m: -m["t"])


def file(rid: str, first: str, last: str):
    """(percorso, nome da dare al file) se la registrazione è di questa persona, altrimenti None."""
    if not re.fullmatch(r"[\w-]+", rid):
        return None
    m = _meta(rid)
    if not m or _key(first, last) not in m.get("keys", []):
        return None
    d = _dir() / rid
    p = d / "rec.m4a" if (d / "rec.m4a").exists() else d / "rec.webm"
    if not p.exists():
        return None
    when = time.strftime("%Y-%m-%d", time.localtime(m["t"]))
    safe = re.sub(r'[\\/:*?"<>|]+', "", f"{m['title']} - {' e '.join(m['names'])} {when}").strip()
    return p, f"{safe or 'esibizione'}{p.suffix}"


def delete(rid: str, first: str, last: str) -> bool:
    if not re.fullmatch(r"[\w-]+", rid):
        return False
    m = _meta(rid)
    if not m or _key(first, last) not in m.get("keys", []):
        return False
    shutil.rmtree(_dir() / rid, ignore_errors=True)
    return True


def cleanup(now: float | None = None) -> int:
    """Cancella le registrazioni più vecchie di KEEP_DAYS giorni. Restituisce quante."""
    now = time.time() if now is None else now
    gone = 0
    for d in _dir().iterdir():
        m = _meta(d.name) if d.is_dir() else None
        if d.is_dir() and (m is None or now - m.get("t", 0) > KEEP_DAYS * 86400):
            shutil.rmtree(d, ignore_errors=True)
            gone += 1
    return gone
