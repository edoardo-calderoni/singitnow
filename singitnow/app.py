"""Server HTTP/WebSocket: serve l'interfaccia desktop, l'app mobile e le API."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager

import segno
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, config, youtube
from .events import hub
from .library import READY, library
from .pipeline import pipeline
from .playlist import playlist

log = logging.getLogger(__name__)

MEDIA_FILES = {"video.mp4", "instrumental.m4a", "vocals.m4a", "thumb.jpg"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.ensure_dirs()
    hub.bind_loop(asyncio.get_running_loop())
    library.load()
    playlist.load()
    pipeline.on_ready(playlist.song_ready)
    pipeline.start()
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
        results = await run_in_threadpool(youtube.search, q)
    except Exception as e:
        log.exception("Ricerca fallita")
        raise HTTPException(502, f"Ricerca YouTube non riuscita: {e}")
    for r in results:
        s = library.get(r["youtube_id"])
        r["in_library"] = s.status if s else None
    return results


@app.post("/api/download")
def download(req: DownloadReq):
    song = pipeline.enqueue(req.youtube_id, req.title, req.channel, req.duration)
    if req.singer.strip():
        playlist.add(song.id, req.singer)
    return song.to_public()


# ------------------------------------------------------------------ playlist / player
@app.get("/api/playlist")
def get_playlist():
    return playlist.snapshot()


@app.post("/api/playlist")
def queue_song(req: QueueReq):
    if not library.get(req.song_id):
        raise HTTPException(404, "Brano non in libreria")
    playlist.add(req.song_id, req.singer)
    return playlist.snapshot()


@app.delete("/api/playlist/{entry_id}")
def unqueue(entry_id: str):
    playlist.remove(entry_id)
    return playlist.snapshot()


@app.post("/api/playlist/{entry_id}/move")
def move(entry_id: str, req: MoveReq):
    playlist.move(entry_id, req.delta)
    return playlist.snapshot()


@app.post("/api/player/play")
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


@app.post("/api/player/stop")
def stop():
    playlist.stop()
    return playlist.snapshot()


@app.post("/api/player/command")
def command(req: CommandReq):
    """Comandi dai telefoni verso il player (pausa, ripresa, volume voce)."""
    if req.action not in {"pause", "resume", "toggle", "vocals", "restart"}:
        raise HTTPException(400, "Comando sconosciuto")
    hub.publish("player_command", req.model_dump())
    return {"ok": True}


# ------------------------------------------------------------------ realtime
@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await hub.connect(websocket)
    try:
        await websocket.send_text(json.dumps({"event": "playlist", "data": playlist.snapshot()}))
        while True:
            await websocket.receive_text()  # keep-alive dal client
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
