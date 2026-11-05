"""Server HTTP/WebSocket: serve l'interfaccia desktop, l'app mobile e le API."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager

import segno
from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, admin, avatars, config, mode, youtube
from .events import hub
from .library import READY, library
from .pipeline import pipeline
from .playlist import playlist

log = logging.getLogger(__name__)

MEDIA_FILES = {"video.mp4", "instrumental.m4a", "vocals.m4a", "thumb.jpg", "cover.jpg"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.ensure_dirs()
    hub.bind_loop(asyncio.get_running_loop())
    library.load()
    playlist.load()
    pipeline.on_ready(playlist.song_ready)
    pipeline.start()
    pipeline.backfill_covers()
    yield


app = FastAPI(title="SingITnow", version=__version__, lifespan=lifespan)


# ------------------------------------------------------------------ modelli richieste
class DownloadReq(BaseModel):
    youtube_id: str
    title: str = ""
    channel: str = ""
    duration: float = 0
    singer: str = ""


class QueueReq(BaseModel):
    song_id: str
    singer: str = ""


class MoveReq(BaseModel):
    delta: int


class AdminLoginReq(BaseModel):
    password: str
    name: str = ""


class ApplauseReq(BaseModel):
    name: str


class PlayerState(BaseModel):
    song_id: str
    t: float  # posizione nel brano (secondi)
    duration: float
    playing: bool
    offset: float = 0.0  # correzione anticipo/ritardo del testo
    vocals: float = 0.0  # volume della voce guida (0..1)
    volume: float = 1.0  # volume generale, base + voce (0..1)


# Ultima posizione comunicata dal player della TV (per tempi di attesa e testo sui telefoni)
player_state: dict | None = None


class PlayReq(BaseModel):
    entry_id: str | None = None
    song_id: str | None = None
    singer: str = ""


class ResyncReq(BaseModel):
    artist: str
    title: str


class CommandReq(BaseModel):
    action: str
    value: float | None = None
    singer: str = ""  # chi invia il comando dal telefono


# ------------------------------------------------------------------ info
@app.get("/api/info")
def info():
    remote = f"http://{config.lan_ip()}:{config.PORT}/remote"
    qr = segno.make(remote, error="m")
    return {
        "version": __version__,
        "remote_url": remote,
        "qr_svg": qr.svg_inline(scale=6, dark="#0b0b14", light="#ffffff", border=2),
    }


# ------------------------------------------------------------------ libreria
@app.get("/api/songs")
def songs():
    return [s.to_public() for s in library.all()]


@app.get("/api/songs/{song_id}/lyrics")
def song_lyrics(song_id: str):
    song = library.get(song_id)
    path = song.dir / "lyrics.json" if song else None
    if not path or not path.exists():
        raise HTTPException(404, "Testo non disponibile")
    return json.loads(path.read_text(encoding="utf-8"))


@app.delete("/api/songs/{song_id}")
def delete_song(song_id: str):
    song = library.get(song_id)
    if not song:
        raise HTTPException(404)
    if song.status not in (READY, "error"):
        raise HTTPException(409, "Brano in elaborazione")
    playlist.forget_song(song_id)
    library.remove(song_id)
    return {"ok": True}


class SongPatch(BaseModel):
    artist: str | None = None
    title: str | None = None
    language: str | None = None


@app.patch("/api/songs/{song_id}")
def patch_song(song_id: str, req: SongPatch):
    """Correzione manuale dei metadati (artista, titolo, lingua)."""
    changes = {k: v.strip() for k, v in req.model_dump().items() if v is not None}
    song = library.update(song_id, **changes)
    if not song:
        raise HTTPException(404)
    return song.to_public()


@app.post("/api/songs/{song_id}/retry")
def retry_song(song_id: str):
    song = library.get(song_id)
    if not song:
        raise HTTPException(404)
    pipeline.enqueue(song.youtube_id)
    return {"ok": True}


@app.post("/api/songs/{song_id}/lyrics/resync")
def resync(song_id: str, req: ResyncReq):
    song = library.get(song_id)
    if not song or song.status != READY:
        raise HTTPException(409, "Il brano deve essere pronto")
    pipeline.resync_lyrics(song_id, req.artist.strip(), req.title.strip())
    return {"ok": True}


# ------------------------------------------------------------------ youtube
@app.get("/api/search")
async def search(q: str):
    q = q.strip()
    if not q:
        return []
    try:
        # in background si cerca il videoclip ufficiale (senza testo a schermo)
        results = await run_in_threadpool(youtube.search, youtube.official_query(q))
    except Exception as e:
        log.exception("Ricerca fallita")
        raise HTTPException(502, f"Ricerca YouTube non riuscita: {e}")
    for r in results:
        s = library.get(r["youtube_id"])
        r["in_library"] = s.status if s else None
    return results


ONE_AT_A_TIME = "Prima esibisciti e poi aggiungi un altro brano"


def _check_one_at_a_time(request: Request, singer: str, token: str | None) -> None:
    """Karaoke: gli utenti normali hanno un solo brano in coda alla volta (admin e TV senza limiti).
    In modalità Jukebox nessun limite."""
    if singer.strip() and not mode.is_jukebox() and not admin.can_control(request, token) and playlist.has_pending(singer):
        raise HTTPException(409, ONE_AT_A_TIME)


@app.post("/api/download")
def download(req: DownloadReq, request: Request, x_admin_token: str | None = Header(default=None)):
    _check_one_at_a_time(request, req.singer, x_admin_token)
    song = pipeline.enqueue(req.youtube_id, req.title, req.channel, req.duration)
    if req.singer.strip():
        playlist.add(song.id, req.singer)
    return song.to_public()


# ------------------------------------------------------------------ playlist / player
@app.get("/api/users")
def connected_users():
    """Utenti collegati dal telefono in questo momento."""
    return {"users": hub.users()}


@app.get("/api/playlist")
def get_playlist():
    return playlist.snapshot()


@app.post("/api/playlist")
def queue_song(req: QueueReq, request: Request, x_admin_token: str | None = Header(default=None)):
    if not library.get(req.song_id):
        raise HTTPException(404, "Brano non in libreria")
    _check_one_at_a_time(request, req.singer, x_admin_token)
    playlist.add(req.song_id, req.singer)
    return playlist.snapshot()


@app.delete("/api/playlist/waiting/{song_id}")
def unqueue_waiting(song_id: str, singer: str):
    """Annulla la prenotazione di un brano ancora in preparazione (il brano resta in libreria)."""
    playlist.remove_waiting(song_id, singer)
    return playlist.snapshot()


@app.delete("/api/playlist/{entry_id}")
def unqueue(entry_id: str, request: Request, singer: str = "", x_admin_token: str | None = Header(default=None)):
    """Toglie un brano dalla coda: ognuno i propri, gli amministratori (e la TV) qualsiasi."""
    if not admin.can_control(request, x_admin_token):
        owner = playlist.singer_of(entry_id)
        if owner is not None and owner != singer:
            raise HTTPException(403, "Puoi togliere solo le tue prenotazioni")
    playlist.remove(entry_id)
    return playlist.snapshot()


@app.post("/api/playlist/{entry_id}/move", dependencies=[Depends(admin.require_control)])
def move(entry_id: str, req: MoveReq):
    playlist.move(entry_id, req.delta)
    return playlist.snapshot()


@app.post("/api/player/play", dependencies=[Depends(admin.require_control)])
def play(req: PlayReq):
    if req.song_id:
        song = library.get(req.song_id)
        if not song or song.status != READY:
            raise HTTPException(409, "Brano non pronto")
        playlist.play_song(req.song_id, req.singer)
    else:
        if not playlist.play(req.entry_id):
            raise HTTPException(404, "Coda vuota")
    return playlist.snapshot()


@app.post("/api/player/stop", dependencies=[Depends(admin.require_control)])
def stop():
    global player_state
    playlist.stop()
    player_state = None
    hub.publish("player_state", None)
    return playlist.snapshot()


@app.post("/api/player/next", dependencies=[Depends(admin.require_control)])
def play_next():
    """Passa al brano successivo; con la coda vuota ferma il brano in corso."""
    if not playlist.play(None):
        return stop()
    return playlist.snapshot()


@app.post("/api/player/state")
def set_player_state(req: PlayerState):
    """Il player della TV comunica periodicamente dove si trova."""
    global player_state
    player_state = req.model_dump()
    hub.publish("player_state", player_state)
    return {"ok": True}


@app.post("/api/player/command", dependencies=[Depends(admin.require_control)])
def command(req: CommandReq):
    """Comandi dagli amministratori verso il player (pausa, ripresa, volume voce)."""
    if req.action not in {"pause", "resume", "toggle", "vocals", "volume", "restart"}:
        raise HTTPException(400, "Comando sconosciuto")
    if req.action == "vocals" and mode.is_jukebox():
        raise HTTPException(409, "In modalità Jukebox la voce originale resta al massimo")
    hub.publish("player_command", req.model_dump())
    return {"ok": True}


# ------------------------------------------------------------------ amministratori
@app.post("/api/admin/login")
def admin_login(req: AdminLoginReq):
    token = admin.login(req.password, req.name)
    if not token:
        raise HTTPException(401, "Password non corretta")
    return {"token": token}


@app.get("/api/admin/check")
def admin_check(x_admin_token: str | None = Header(default=None)):
    return {"admin": admin.is_admin(x_admin_token)}


@app.post("/api/admin/qr", dependencies=[Depends(admin.require_admin)])
def admin_show_qr():
    """Mostra per qualche secondo il QR code d'ingresso nell'angolo della TV."""
    hub.publish("show_qr", {"seconds": 10})
    return {"ok": True}


class ModeReq(BaseModel):
    mode: str


@app.get("/api/mode")
def get_mode():
    return mode.public()


@app.post("/api/admin/mode", dependencies=[Depends(admin.require_control)])
def set_mode(req: ModeReq):
    """Karaoke o Jukebox: la sceglie un amministratore dal telefono oppure la TV (il PC stesso)."""
    if req.mode not in mode.MODES:
        raise HTTPException(400, "Modalità sconosciuta")
    return mode.set_mode(req.mode)


@app.post("/api/admin/logout")
def admin_logout(x_admin_token: str | None = Header(default=None)):
    admin.logout(x_admin_token)
    return {"admin": False}


# ------------------------------------------------------------------ applausi
_applause_log: dict[str, list[float]] = {}
APPLAUSE_MAX = 8  # applausi per persona…
APPLAUSE_WINDOW = 2.0  # …ogni 2 secondi: oltre si ignorano (la TV non viene sommersa da un solo telefono)


@app.post("/api/applause")
def applause(req: ApplauseReq):
    """Un applauso dal telefono: sulla TV sale una bolla con la foto di chi applaude."""
    import time

    name = req.name.strip()[:40]
    if not name or not playlist.now_playing or mode.is_jukebox():
        return {"ok": False}
    now = time.monotonic()
    recent = [t for t in _applause_log.get(name, []) if now - t < APPLAUSE_WINDOW]
    if len(recent) >= APPLAUSE_MAX:
        return {"ok": False}
    recent.append(now)
    _applause_log[name] = recent
    hub.publish("applause", {"name": name})
    return {"ok": True}


# ------------------------------------------------------------------ foto profilo
@app.get("/api/avatars")
def list_avatars():
    return avatars.public_map()


@app.get("/api/avatars/{name}")
def get_avatar(name: str):
    p = avatars.path(name)
    if not p:
        raise HTTPException(404)
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=31536000"})


@app.put("/api/avatars/{name}")
async def put_avatar(name: str, request: Request):
    """Corpo della richiesta: la foto in JPEG (già ritagliata e ridotta dal telefono)."""
    try:
        avatars.save(name, await request.body())
    except ValueError as e:
        raise HTTPException(400, str(e))
    return avatars.public_map()


@app.delete("/api/avatars/{name}")
def delete_avatar(name: str):
    avatars.remove(name)
    return avatars.public_map()


# ------------------------------------------------------------------ realtime
@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await hub.connect(websocket)
    try:
        await websocket.send_text(json.dumps({"event": "playlist", "data": playlist.snapshot()}))
        await websocket.send_text(json.dumps({"event": "player_state", "data": player_state}))
        await websocket.send_text(json.dumps({"event": "avatars", "data": avatars.public_map()}))
        await websocket.send_text(json.dumps({"event": "mode", "data": mode.public()}))
        while True:
            msg = await websocket.receive_text()  # "ping" (keep-alive) oppure {"hello": "<nome>"}
            if msg.startswith("{"):
                try:
                    data = json.loads(msg)
                except ValueError:
                    continue
                if isinstance(data, dict) and "hello" in data:
                    hub.set_name(websocket, str(data["hello"] or ""))
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(websocket)


# ------------------------------------------------------------------ file media
@app.get("/media/{song_id}/{name}")
def media(song_id: str, name: str):
    song = library.get(song_id)
    if not song or name not in MEDIA_FILES:
        raise HTTPException(404)
    path = song.dir / name
    if not path.exists():
        raise HTTPException(404)
    # FileResponse gestisce le richieste Range (necessarie per lo scorrimento del video).
    return FileResponse(path, headers={"Cache-Control": "max-age=3600"})


# ------------------------------------------------------------------ frontend
def _page(name: str):
    page = config.FRONTEND_DIST / name
    if not page.exists():
        return HTMLResponse(
            "<h1>Interfaccia non compilata</h1><p>Esegui <code>npm run build</code> nella cartella frontend.</p>",
            status_code=503,
        )
    return FileResponse(page, headers={"Cache-Control": "no-cache"})


@app.get("/", include_in_schema=False)
def index():
    return _page("index.html")


@app.get("/remote", include_in_schema=False)
def remote():
    return _page("remote.html")


if (config.FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=config.FRONTEND_DIST / "assets"), name="assets")

if config.FRONTEND_DIST.exists():
    # manifest, icone e service worker della PWA
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIST), name="static")
