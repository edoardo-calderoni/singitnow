"""Backup della libreria: esportazione in un .zip e importazione (anche su un altro PC).

Due tipi di esportazione:
- «solo dati» (pochi MB): dati dei brani, testi (anche corretti a mano), trascrizioni, ritmo, note,
  copertine, voti (Hall of Fame), profili e foto;
- «completo»: in più video, tracce audio e registrazioni (anche diversi GB).
Non si esportano la password amministratore né i settaggi (c'è la password del Wi-Fi).

All'importazione i brani che mancano si aggiungono: pronti se il backup ha i file, altrimenti si
riscaricano da YouTube tenendo il testo del backup (il video è lo stesso, quindi anche i tempi). Per
i brani già presenti si prende il testo del backup solo se è stato corretto a mano e quello del PC
no. Voti, storico dei profili e foto si uniscono a quelli che ci sono già.
"""

from __future__ import annotations

import json
import logging
import shutil
import threading
import time
import zipfile
from pathlib import Path

from . import config
from .events import hub
from .library import QUEUED, READY, Song, library

log = logging.getLogger(__name__)

DATA_FILES = {"song.json", "lyrics.json", "whisper.json", "beats.json", "pitch.json", "cover.jpg", "thumb.jpg", "cover.none"}
MEDIA_FILES = {"video.mp4", "instrumental.m4a", "vocals.m4a"}
KEEP_LYRICS = "lyrics.keep"  # brano riscaricato da un backup: la pipeline non rigenera il testo
FORMAT = 1

_lock = threading.Lock()
_state: dict = {"running": False}


def downloads_dir() -> Path:
    d = Path.home() / "Downloads"
    return d if d.is_dir() else Path.home()


def _files(full: bool) -> list[tuple[Path, str]]:
    """(file sul disco, percorso nel .zip) di tutto ciò che va nel backup."""
    out: list[tuple[Path, str]] = []
    for s in library.all():
        if s.status != READY or not s.dir.is_dir():
            continue  # i brani in preparazione si riprendono importandoli di nuovo
        for f in s.dir.iterdir():
            if f.is_file() and (f.name in DATA_FILES or (full and f.name in MEDIA_FILES)):
                out.append((f, f"library/{s.id}/{f.name}"))
    for sub in ("profiles", "avatars") + (("recordings",) if full else ()):
        root = config.DATA_DIR / sub
        if root.is_dir():
            out += [(f, f"{sub}/{f.relative_to(root).as_posix()}") for f in root.rglob("*") if f.is_file()]
    scores = config.DATA_DIR / "scores.json"
    if scores.exists():
        out.append((scores, "scores.json"))
    return out


def estimate() -> dict:
    """Dimensione prevista dei due tipi di backup (byte)."""
    size = lambda files: sum(f.stat().st_size for f, _ in files)  # noqa: E731
    return {"data": size(_files(False)), "full": size(_files(True))}


def export(full: bool, dest_dir: Path | None = None) -> Path:
    """Scrive il backup e restituisce il percorso del .zip. Avvisa i client dell'avanzamento."""
    files = _files(full)
    total = sum(f.stat().st_size for f, _ in files) or 1
    name = time.strftime("SingITnow-backup-%Y%m%d-%H%M") + ("-completo" if full else "") + ".zip"
    dest = (dest_dir or downloads_dir()) / name
    tmp = dest.with_suffix(".part")
    done = 0
    last = 0.0
    with zipfile.ZipFile(tmp, "w") as z:
        z.writestr("manifest.json", json.dumps({"format": FORMAT, "created": time.time(), "full": full}))
        for f, arc in files:
            # video e audio sono già compressi: si salvano così come sono (molto più veloce)
            kind = zipfile.ZIP_STORED if f.suffix in (".mp4", ".m4a", ".jpg", ".webm") else zipfile.ZIP_DEFLATED
            z.write(f, arc, compress_type=kind)
            done += f.stat().st_size
            if time.time() - last > 0.5:
                last = time.time()
                hub.publish("backup", {"state": "export", "progress": round(done / total, 3)})
    tmp.replace(dest)
    return dest


def start_export(full: bool) -> None:
    """Esportazione in background (un backup completo può richiedere qualche minuto)."""
    with _lock:
        if _state.get("running"):
            raise RuntimeError("C'è già un backup in corso")
        _state.update(running=True)

    def run() -> None:
        try:
            path = export(full)
            hub.publish("backup", {"state": "done", "path": str(path), "folder": str(path.parent),
                                   "size": path.stat().st_size})
        except Exception as e:
            log.exception("Backup non riuscito")
            hub.publish("backup", {"state": "error", "error": str(e)[:300]})
        finally:
            with _lock:
                _state.update(running=False)

    threading.Thread(target=run, name="backup", daemon=True).start()


# ------------------------------------------------------------------ importazione
def _merge_list(path: Path, incoming: list, key) -> int:
    """Unisce a una lista JSON sul disco le voci nuove (riconosciute da key). Restituisce quante."""
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
        current = current if isinstance(current, list) else []
    except (OSError, ValueError):
        current = []
    seen = {key(r) for r in current if isinstance(r, dict)}
    new = [r for r in incoming if isinstance(r, dict) and key(r) not in seen]
    if new:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(current + new, ensure_ascii=False), encoding="utf-8")
    return len(new)


def _manual(lyrics: dict | None) -> bool:
    return bool(lyrics) and str(lyrics.get("source", "")).startswith("manual")


def restore(zip_path: Path) -> dict:
    """Importa un backup. Restituisce il riepilogo: brani aggiunti (pronti / da riscaricare), testi
    aggiornati, voti e profili uniti."""
    out = {"added": 0, "to_download": 0, "lyrics": 0, "scores": 0, "history": 0, "photos": 0}
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        if "manifest.json" not in names:
            raise ValueError("Non è un backup di SingITnow")
        songs: dict[str, list[str]] = {}
        for n in names:
            parts = n.split("/")
            if len(parts) == 3 and parts[0] == "library" and parts[2] and "\\" not in n and ".." not in parts:
                songs.setdefault(parts[1], []).append(parts[2])
        for sid, files in songs.items():
            if "song.json" not in files:
                continue
            existing = library.get(sid)
            if existing:
                # brano già presente: si prende il testo corretto a mano del backup
                if "lyrics.json" in files:
                    theirs = json.loads(z.read(f"library/{sid}/lyrics.json"))
                    try:
                        mine = json.loads((existing.dir / "lyrics.json").read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        mine = None
                    if _manual(theirs) and not _manual(mine):
                        for f in ("lyrics.json", "pitch.json"):
                            if f in files:
                                (existing.dir / f).write_bytes(z.read(f"library/{sid}/{f}"))
                        out["lyrics"] += 1
                continue
            d = config.LIBRARY_DIR / sid
            d.mkdir(parents=True, exist_ok=True)
            for f in files:
                if f in DATA_FILES or f in MEDIA_FILES:
                    with z.open(f"library/{sid}/{f}") as src, open(d / f, "wb") as dst:
                        shutil.copyfileobj(src, dst)
            raw = json.loads((d / "song.json").read_text(encoding="utf-8"))
            song = Song(**{k: v for k, v in raw.items() if k in Song.__dataclass_fields__})
            ready = all((d / f).exists() for f in MEDIA_FILES) and (d / "lyrics.json").exists()
            if ready:
                song.status, song.progress, song.step, song.eta = READY, 1.0, "Pronto", 0.0
            else:
                song.status, song.progress, song.step, song.eta, song.error = QUEUED, 0.0, "In coda", 0.0, ""
                if (d / "lyrics.json").exists():
                    (d / KEEP_LYRICS).touch()  # si riscarica, ma il testo resta quello del backup
                out["to_download"] += 1
            song.queue_pos = 0
            library.add(song)
            out["added"] += 1

        if "scores.json" in names:
            out["scores"] = _merge_list(
                config.DATA_DIR / "scores.json", json.loads(z.read("scores.json")),
                lambda r: (r.get("first"), r.get("last"), r.get("singer"), r.get("song_id"), r.get("t")),
            )
        if "profiles/history.json" in names:
            out["history"] = _merge_list(
                config.DATA_DIR / "profiles" / "history.json", json.loads(z.read("profiles/history.json")),
                lambda r: (r.get("key"), r.get("entry"), r.get("t")),
            )
        # foto (profili e partecipanti) e registrazioni: si aggiungono quelle che mancano
        avatar_index = None
        for n in names:
            top = n.split("/")[0]
            if top not in ("profiles", "avatars", "recordings") or n.endswith("/") or ".." in n.split("/"):
                continue
            if n in ("profiles/history.json", "avatars/index.json"):
                continue
            target = config.DATA_DIR / n
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(n) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                out["photos"] += n.endswith(".jpg")
        if "avatars/index.json" in names:
            avatar_index = json.loads(z.read("avatars/index.json"))
            path = config.DATA_DIR / "avatars" / "index.json"
            try:
                current = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                current = {}
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(avatar_index | current, ensure_ascii=False), encoding="utf-8")
    return out
