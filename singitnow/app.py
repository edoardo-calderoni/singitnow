"""Server HTTP/WebSocket: serve l'interfaccia desktop, l'app mobile e le API."""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from pathlib import Path
from contextlib import asynccontextmanager

import segno
from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, admin, audio, avatars, competition, config, halloffame, mics, mode, names, party, people, stats, wifi, youtube
from .events import hub
from .library import READY, library
from .pipeline import pipeline
from .playlist import playlist
from .voice import voice

log = logging.getLogger(__name__)

MEDIA_FILES = {"video.mp4", "instrumental.m4a", "vocals.m4a", "thumb.jpg", "cover.jpg"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.ensure_dirs()
    hub.bind_loop(asyncio.get_running_loop())
    library.load()
    playlist.load()
    party.restore()  # app chiusa a metà serata: partecipanti, voti e competizione come prima
    pipeline.on_ready(playlist.song_ready)
    pipeline.start()
    pipeline.backfill_covers()
    pipeline.backfill_pitch()
    pipeline.backfill_voice_snap()
    pipeline.backfill_beats()
    # voce dei microfoni gestita da SingITnow (autotune): il motore audio parte se è stato scelto
    threading.Thread(target=voice.apply, name="voce-avvio", daemon=True).start()
    yield
    voice.shutdown()


app = FastAPI(title="SingITnow", version=__version__, lifespan=lifespan)


# ------------------------------------------------------------------ modelli richieste
class DownloadReq(BaseModel):
    youtube_id: str
    title: str = ""  # titolo del video su YouTube
    channel: str = ""
    duration: float = 0
    singer: str = ""
    # artista e titolo del brano confermati da chi lo importa (i refusi vengono corretti col video)
    artist: str = ""
    name: str = ""


class QueueReq(BaseModel):
    song_id: str
    singer: str = ""


class MoveReq(BaseModel):
    delta: int
    singer: str = ""  # chi sposta dal telefono (il DJ della serata può farlo)


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
    key: int = 0  # tonalità della base in semitoni rispetto all'originale


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
    base = f"http://{config.lan_ip()}:{config.PORT}"
    remote = f"{base}/remote"
    # il QR porta a /join: da Android scarica subito l'app, dagli altri telefoni apre la pagina
    qr = segno.make(f"{base}/join", error="m")
    return {
        "version": __version__,
        "remote_url": remote,
        "qr_svg": qr.svg_inline(scale=6, dark="#0b0b14", light="#ffffff", border=2, omitsize=True),  # viewBox: si adatta al riquadro
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


@app.get("/api/songs/{song_id}/pitch")
def song_pitch(song_id: str):
    """Note della melodia cantata (per le barre dell'intonazione)."""
    song = library.get(song_id)
    path = song.dir / "pitch.json" if song else None
    if not path or not path.exists():
        raise HTTPException(404, "Note non disponibili")
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/api/songs/{song_id}/beats")
def song_beats(song_id: str):
    """Griglia del ritmo all'inizio e alla fine del brano (per il mix in battuta)."""
    song = library.get(song_id)
    path = song.dir / "beats.json" if song else None
    if not path or not path.exists():
        raise HTTPException(404, "Ritmo non disponibile")
    return json.loads(path.read_text(encoding="utf-8"))


@app.delete("/api/songs/{song_id}")
def delete_song(song_id: str):
    song = library.get(song_id)
    if not song:
        raise HTTPException(404)
    if song.status not in (READY, "error"):
        # in preparazione: si ferma l'importazione e si cancella tutto
        playlist.forget_song(song_id)
        pipeline.cancel(song_id)
        return {"ok": True}
    playing = playlist.is_playing_song(song_id)
    playlist.forget_song(song_id)
    if playing:
        _drop_now_playing()  # stava suonando: si passa al prossimo (o alla schermata principale)
    library.remove(song_id)
    return {"ok": True}


class SongPatch(BaseModel):
    artist: str | None = None
    title: str | None = None
    language: str | None = None


@app.patch("/api/songs/{song_id}")
def patch_song(song_id: str, req: SongPatch):
    """Correzione manuale dei metadati (artista, titolo, lingua)."""
    changes: dict = {k: v.strip() for k, v in req.model_dump().items() if v is not None}
    if changes.get("artist") or changes.get("title"):
        changes["confirmed"] = True  # corretti a mano: il download non li sovrascrive più
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


class LyricsTextReq(BaseModel):
    text: str


@app.put("/api/songs/{song_id}/lyrics", dependencies=[Depends(admin.require_control)])
def set_lyrics(song_id: str, req: LyricsTextReq):
    """Testo corretto a mano (una riga per riga del karaoke): viene risincronizzato con la voce."""
    song = library.get(song_id)
    if not song or song.status != READY:
        raise HTTPException(409, "Il brano deve essere pronto")
    text = "\n".join(l.strip() for l in req.text.replace("\r", "").split("\n"))
    if not text.strip():
        raise HTTPException(400, "Il testo è vuoto")
    if len(text) > 20000:
        raise HTTPException(400, "Il testo è troppo lungo")
    pipeline.set_lyrics_text(song_id, text)
    return {"ok": True}


@app.post("/api/songs/{song_id}/lyrics/resync")
def resync(song_id: str, req: ResyncReq):
    song = library.get(song_id)
    if not song or song.status != READY:
        raise HTTPException(409, "Il brano deve essere pronto")
    pipeline.resync_lyrics(song_id, req.artist.strip(), req.title.strip())
    return {"ok": True}


# ------------------------------------------------------------------ youtube
SEARCH_MAX = 60  # risultati al massimo con «Carica altri risultati»


@app.get("/api/search")
async def search(q: str, limit: int = 12):
    """Ricerca su YouTube; `limit` cresce di 12 ogni volta che si tocca «Carica altri risultati»."""
    q = q.strip()
    limit = max(1, min(limit, SEARCH_MAX))
    if not q:
        return []
    video_id = youtube.video_id_from_url(q)
    try:
        if video_id:
            # link incollato: si importa esattamente quel video
            results = [await run_in_threadpool(youtube.video_info, video_id)]
        else:
            # in background si cerca il videoclip ufficiale (senza testo a schermo)
            results = await run_in_threadpool(youtube.search_song, q, limit)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        if video_id:
            log.warning("Video %s non disponibile: %s", video_id, e)
            raise HTTPException(404, "Video non disponibile: controlla il link (potrebbe essere privato o rimosso)")
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


LOCKED = "Al momento non è possibile aggiungere brani alla playlist"


def _check_unlocked(request: Request, token: str | None, singer: str = "") -> None:
    """«Blocca inserimenti»: aggiungono brani solo il PC e gli amministratori."""
    if mode.locked() and not admin.can_control(request, token):
        raise HTTPException(423, LOCKED)


def _needs_dj(request: Request, token: str | None, singer: str) -> bool:
    """Modalità DJ: i brani aggiunti dagli utenti (non DJ, non amministratori, non dal PC) diventano
    richieste che il DJ deve accettare."""
    return mode.get() == mode.DJ and not admin.can_control(request, token) and not mode.is_dj(singer)


ONE_REQUEST = "Hai già una richiesta in attesa del DJ: aspetta che la accetti o la rifiuti"


def _check_one_request(request: Request, token: str | None, singer: str) -> None:
    """Modalità DJ: una sola richiesta in attesa per utente."""
    if singer.strip() and _needs_dj(request, token, singer) and playlist.has_request(singer):
        raise HTTPException(409, ONE_REQUEST)


def _autostart(request: Request, token: str | None) -> bool:
    """Il brano aggiunto fa partire la playlist ferma? Solo se lo aggiunge un utente dal telefono e
    «Riproduzione automatica» è accesa; dal PC (e dagli amministratori) si usa «Avvia playlist»."""
    return not admin.can_control(request, token) and mode.autoplay()


@app.get("/api/import/guess")
def import_guess(title: str = "", channel: str = ""):
    """Artista e titolo proposti dai dati del video, da confermare prima dell'importazione."""
    artist, name = names.guess(title, channel)
    return {"artist": artist, "title": name}


@app.post("/api/download")
def download(req: DownloadReq, request: Request, x_admin_token: str | None = Header(default=None)):
    _check_unlocked(request, x_admin_token, req.singer)
    _check_one_at_a_time(request, req.singer, x_admin_token)
    _check_one_request(request, x_admin_token, req.singer)
    artist, name = req.artist.strip(), req.name.strip()
    if artist and name:
        artist, name = names.correct(artist, name, req.title, req.channel)
    song = pipeline.enqueue(req.youtube_id, req.title, req.channel, req.duration, artist[:120], name[:160])
    if req.singer.strip() and _needs_dj(request, x_admin_token, req.singer):
        playlist.request(song.id, req.singer)  # il brano si prepara intanto, il DJ decide se metterlo
    elif req.singer.strip():
        playlist.add(song.id, req.singer, autostart=_autostart(request, x_admin_token), from_pc=admin.is_local(request))
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
    _check_unlocked(request, x_admin_token, req.singer)
    _check_one_at_a_time(request, req.singer, x_admin_token)
    _check_one_request(request, x_admin_token, req.singer)
    if req.singer.strip() and _needs_dj(request, x_admin_token, req.singer):
        playlist.request(req.song_id, req.singer)
        return playlist.snapshot()
    playlist.add(req.song_id, req.singer, autostart=_autostart(request, x_admin_token), from_pc=admin.is_local(request))
    return playlist.snapshot()


@app.delete("/api/playlist/waiting/{song_id}")
def unqueue_waiting(song_id: str, singer: str, request: Request, x_admin_token: str | None = Header(default=None)):
    """Annulla la prenotazione di un brano ancora in preparazione (il brano resta in libreria)."""
    _check_playlist_open(request, x_admin_token)
    playlist.remove_waiting(song_id, singer)
    # nessun altro aspetta quel brano: l'importazione si ferma e il brano viene cancellato
    if not playlist.wants_song(song_id):
        pipeline.cancel(song_id)
    return playlist.snapshot()


@app.delete("/api/playlist/{entry_id}")
def unqueue(entry_id: str, request: Request, singer: str = "", x_admin_token: str | None = Header(default=None)):
    """Toglie un brano dalla coda: ognuno i propri, gli amministratori (e la TV) e il DJ qualsiasi."""
    _check_playlist_open(request, x_admin_token)
    if not _can_manage(request, x_admin_token, singer):
        owner = playlist.singer_of(entry_id)
        if owner is not None and owner != singer:
            raise HTTPException(403, "Puoi togliere solo le tue prenotazioni")
    if playlist.is_playing(entry_id):
        _drop_now_playing()
    else:
        playlist.remove(entry_id)
    return playlist.snapshot()


def _drop_now_playing() -> None:
    """Il brano in riproduzione è stato tolto: si interrompe e parte il primo in coda;
    con la coda vuota la TV torna alla schermata principale."""
    if not playlist.play(None):
        stop()


def _can_manage(request: Request, token: str | None, singer: str) -> bool:
    """Gestione della scaletta (togliere e spostare qualsiasi brano): PC, amministratori e,
    in modalità DJ, il DJ della serata (non con «Blocca inserimenti e richieste»)."""
    if admin.can_control(request, token):
        return True
    return not mode.locked() and mode.get() == mode.DJ and mode.is_dj(singer)


LOCKED_PLAYLIST = "Al momento solo gli amministratori possono modificare la playlist"


def _check_playlist_open(request: Request, token: str | None) -> None:
    """«Blocca inserimenti e richieste»: la playlist la toccano solo gli amministratori e il PC
    (nessuno toglie più nemmeno i propri brani o ritira le proprie richieste)."""
    if mode.locked() and not admin.can_control(request, token):
        raise HTTPException(423, LOCKED_PLAYLIST)


class DjDecisionReq(BaseModel):
    singer: str = ""  # chi decide dal telefono (il DJ della serata)


@app.post("/api/playlist/requests/{request_id}/approve")
def approve_request(
    request_id: str, req: DjDecisionReq, request: Request, x_admin_token: str | None = Header(default=None)
):
    """Il DJ (o un amministratore, o il PC) accetta una richiesta: il brano entra in playlist e solo
    chi l'ha chiesto riceve l'avviso «<DJ> ha accettato la tua richiesta!»."""
    if not _can_manage(request, x_admin_token, req.singer):
        raise HTTPException(403, "Solo il DJ della serata può accettare le richieste")
    r = playlist.take_request(request_id)
    if not r:
        raise HTTPException(404, "Richiesta non trovata")
    approver = mode.dj() or req.singer.strip() or admin.name_of(x_admin_token) or "Il DJ"
    # come se l'avesse aggiunto il DJ dal telefono: parte da solo se la playlist è ferma
    playlist.add(r["song_id"], r["singer"], autostart=mode.autoplay(), approved_by=approver)
    return playlist.snapshot()


@app.delete("/api/playlist/requests/{request_id}")
def reject_request(request_id: str, request: Request, singer: str = "", x_admin_token: str | None = Header(default=None)):
    """Il DJ rifiuta una richiesta, oppure chi l'ha fatta la ritira."""
    _check_playlist_open(request, x_admin_token)
    owner = playlist.request_owner(request_id)
    if owner is None:
        raise HTTPException(404, "Richiesta non trovata")
    if not _can_manage(request, x_admin_token, singer) and owner != singer:
        raise HTTPException(403, "Puoi ritirare solo le tue richieste")
    playlist.take_request(request_id)
    return playlist.snapshot()


@app.post("/api/playlist/{entry_id}/move")
def move(entry_id: str, req: MoveReq, request: Request, x_admin_token: str | None = Header(default=None)):
    if not _can_manage(request, x_admin_token, req.singer):
        raise HTTPException(403, "Solo gli amministratori e il DJ della serata possono spostare i brani")
    playlist.move(entry_id, req.delta)
    return playlist.snapshot()


# ------------------------------------------------------------------ duetti
class DuetProposeReq(BaseModel):
    singer: str  # chi propone (ha prenotato il brano)
    partner: str  # con chi vorrebbe cantarlo


class DuetAnswerReq(BaseModel):
    singer: str  # chi risponde (ha ricevuto la proposta)
    accept: bool


def _check_duets_allowed(request: Request, token: str | None) -> None:
    """Duetti solo in Karaoke (in Jukebox e DJ non si canta) e con la playlist aperta."""
    _check_playlist_open(request, token)
    if mode.is_jukebox():
        raise HTTPException(409, "I duetti si fanno solo in modalità Karaoke")


@app.post("/api/playlist/{entry_id}/duet")
def propose_duet(entry_id: str, req: DuetProposeReq, request: Request, x_admin_token: str | None = Header(default=None)):
    """Chi ha prenotato un brano propone a un altro utente collegato di cantarlo insieme: al
    telefono dell'invitato arriva la proposta (con vibrazione), che può accettare o rifiutare."""
    _check_duets_allowed(request, x_admin_token)
    partner = req.partner.strip()
    if partner.casefold() not in {u.casefold() for u in hub.users()}:
        raise HTTPException(409, f"{partner or 'Questo utente'} non è più collegato")
    err = playlist.propose_duet(entry_id, req.singer, partner)
    if err:
        raise HTTPException(409, err)
    return playlist.snapshot()


@app.post("/api/duets/{duet_id}/answer")
def answer_duet(duet_id: str, req: DuetAnswerReq, request: Request, x_admin_token: str | None = Header(default=None)):
    """L'invitato accetta o rifiuta: chi ha proposto il duetto riceve la risposta, e se accetta
    il duetto compare in playlist (e sulla TV un avviso)."""
    if req.accept:
        _check_duets_allowed(request, x_admin_token)
    d = playlist.answer_duet(duet_id, req.singer, req.accept)
    if d is None:
        raise HTTPException(404, "La proposta di duetto non è più valida")
    hub.publish(
        "duet",
        {"kind": "accepted" if req.accept else "declined", "from": d["from"], "to": d["to"], "song": d["song"]},
    )
    return playlist.snapshot()


@app.delete("/api/duets/{duet_id}")
def cancel_duet(duet_id: str, request: Request, singer: str = "", x_admin_token: str | None = Header(default=None)):
    """Chi ha proposto il duetto ritira la proposta."""
    if not playlist.cancel_duet(duet_id, singer, force=admin.can_control(request, x_admin_token)):
        raise HTTPException(404, "La proposta di duetto non è più valida")
    return playlist.snapshot()


@app.delete("/api/playlist/{entry_id}/duet")
def leave_duet(entry_id: str, request: Request, singer: str = "", x_admin_token: str | None = Header(default=None)):
    """Il duetto si annulla (il brano resta in coda a nome di chi l'ha prenotato): lo fanno chi
    l'ha prenotato, chi si era unito o un amministratore. L'altro riceve un avviso."""
    _check_playlist_open(request, x_admin_token)
    pair = playlist.leave_duet(entry_id, singer, force=admin.can_control(request, x_admin_token))
    if pair is None:
        raise HTTPException(404, "Nessun duetto da annullare")
    hub.publish("duet", {"kind": "left", "from": pair[0], "to": pair[1], "by": singer.strip()})
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
    voice.on_player(None)
    return playlist.snapshot()


@app.post("/api/player/next", dependencies=[Depends(admin.require_control)])
def play_next():
    """Passa al brano successivo; con la coda vuota ferma il brano in corso."""
    if not playlist.play(None):
        return stop()
    return playlist.snapshot()


def _now_remaining() -> float:
    """Quanto manca alla fine del brano in corso, dall'ultima posizione comunicata dal player."""
    now = playlist.now_playing
    song = library.get(now.song_id) if now else None
    if not song:
        return 0.0
    ps = player_state
    if ps and ps.get("song_id") == song.id:
        return max(0.0, (ps.get("duration") or song.duration) - (ps.get("t") or 0))
    return song.duration  # il player non ha ancora comunicato: brano appena partito


playlist.now_remaining = _now_remaining


@app.post("/api/player/state")
def set_player_state(req: PlayerState):
    """Il player della TV comunica periodicamente dove si trova."""
    global player_state
    player_state = req.model_dump()
    hub.publish("player_state", player_state)
    voice.on_player(player_state)  # l'autotune sa quale nota si dovrebbe cantare adesso
    return {"ok": True}


@app.post("/api/player/command", dependencies=[Depends(admin.require_control)])
def command(req: CommandReq):
    """Comandi dagli amministratori verso il player (pausa, ripresa, volume voce)."""
    if req.action not in {"pause", "resume", "toggle", "vocals", "volume", "restart", "key"}:
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
        raise HTTPException(401, "Password errata")
    return {"token": token}


@app.get("/api/admin/check")
def admin_check(x_admin_token: str | None = Header(default=None)):
    return {"admin": admin.is_admin(x_admin_token)}


@app.post("/api/admin/qr", dependencies=[Depends(admin.require_admin)])
def admin_show_qr():
    """Mostra per qualche secondo il QR code d'ingresso nell'angolo della TV."""
    hub.publish("show_qr", {"seconds": 10})
    return {"ok": True}


# ------------------------------------------------------------------ microfoni
class MicReq(BaseModel):
    volume: float | None = None  # 0..1
    muted: bool | None = None


@app.get("/api/mics", dependencies=[Depends(admin.require_control)])
async def get_mics():
    """Microfoni per cantare (uno o due) con volume e muto: per la TV e per gli amministratori."""
    return {"mics": await run_in_threadpool(mics.list_mics)}


@app.post("/api/mics/{index}", dependencies=[Depends(admin.require_control)])
async def set_mic(index: int, req: MicReq):
    try:
        result = await run_in_threadpool(mics.set_mic, index, req.volume, req.muted)
    except IndexError:
        raise HTTPException(404, "Microfono non trovato: forse è stato scollegato")
    except Exception as e:
        raise HTTPException(500, f"Non riesco a regolare il microfono: {e}")
    hub.publish("mics", {"mics": result})  # TV e telefoni degli amministratori si aggiornano
    return {"mics": result}


# ------------------------------------------------------------------ voce e autotune
class VoiceReq(BaseModel):
    engine: bool | None = None  # True = la voce dei microfoni passa da SingITnow (non da Windows)
    autotune: bool | None = None
    strength: float | None = None  # 0..1


@app.get("/api/voice", dependencies=[Depends(admin.require_control)])
async def get_voice():
    return voice.public()


@app.post("/api/voice", dependencies=[Depends(admin.require_control)])
async def set_voice(req: VoiceReq):
    """Autotune e voce dei microfoni: dal PC o da un amministratore."""
    return await run_in_threadpool(voice.update, **req.model_dump())


# ------------------------------------------------------------------ Wi-Fi per gli ospiti
WIFI_QR_SECONDS = 10  # come il QR d'ingresso


class WifiReq(BaseModel):
    ssid: str = ""
    password: str = ""
    security: str = "WPA"
    hidden: bool = False


@app.get("/api/admin/wifi", dependencies=[Depends(admin.require_admin)])
def admin_get_wifi():
    """Rete salvata (con la password: la vedono solo gli amministratori)."""
    return {"wifi": wifi.get()}


@app.get("/api/admin/wifi/detect", dependencies=[Depends(admin.require_admin)])
async def admin_detect_wifi():
    """Rete Wi-Fi a cui è collegato il PC, per compilare il modulo senza scriverla a mano."""
    found = await run_in_threadpool(wifi.detect)
    if not found:
        raise HTTPException(404, "Il PC non è collegato a una rete Wi-Fi: inseriscila a mano")
    return {"wifi": found}


@app.put("/api/admin/wifi", dependencies=[Depends(admin.require_admin)])
def admin_save_wifi(req: WifiReq):
    try:
        return {"wifi": wifi.save(req.ssid, req.password, req.security, req.hidden)}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/admin/wifi/show", dependencies=[Depends(admin.require_admin)])
def admin_show_wifi():
    """Mostra sulla TV il QR code per collegarsi al Wi-Fi."""
    if not wifi.get():
        raise HTTPException(400, "Imposta prima la rete Wi-Fi")
    # l'evento non contiene la password: la TV la chiede a /api/wifi/qr
    hub.publish("show_wifi", {"seconds": WIFI_QR_SECONDS})
    return {"ok": True}


@app.get("/api/wifi/qr", dependencies=[Depends(admin.require_control)])
def wifi_qr():
    """QR code del Wi-Fi: per la TV (il PC stesso) e per gli amministratori."""
    w = wifi.get()
    if not w:
        raise HTTPException(404, "Rete Wi-Fi non impostata")
    return {"ssid": w["ssid"], "security": w["security"], "qr_svg": wifi.qr_svg(w)}


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


class SettingsReq(BaseModel):
    autoplay: bool | None = None
    locked: bool | None = None


@app.get("/api/settings")
def get_settings():
    return mode.settings_public()


@app.post("/api/admin/settings", dependencies=[Depends(admin.require_control)])
def set_settings(req: SettingsReq):
    """Pannello «Settaggi» dell'app sul PC."""
    if req.autoplay is not None:
        mode.set_autoplay(req.autoplay)
    if req.locked is not None:
        mode.set_locked(req.locked)
    return mode.settings_public()


class PasswordReq(BaseModel):
    old: str
    new: str


@app.post("/api/admin/password", dependencies=[Depends(admin.require_control)])
def change_admin_password(req: PasswordReq):
    """Cambio della password da amministratore: dal pannello «Settaggi» del PC o da un amministratore
    (serve comunque la password attuale)."""
    try:
        admin.change_password(req.old, req.new)
    except ValueError as e:
        raise HTTPException(400, str(e))
    hub.publish("admin_logout", None)  # i telefoni degli amministratori tornano utenti normali
    return {"ok": True}


class DjReq(BaseModel):
    name: str = ""


@app.post("/api/admin/dj", dependencies=[Depends(admin.require_control)])
def set_dj(req: DjReq):
    """Elegge il DJ della serata (modalità DJ): dal PC o da un amministratore. "" = nessuno."""
    return mode.set_dj(req.name)


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
    stats.applause(playlist.now_playing.id)
    hub.publish("applause", {"name": name})
    return {"ok": True}


# ------------------------------------------------------------------ punteggi della serata
class ScoreReq(BaseModel):
    song_id: str
    singer: str = ""
    score: int
    label: str = ""  # con due microfoni: quale microfono (per la scheda sulla TV)
    entry_id: str = ""  # voce della playlist (la competizione esclude il brano in corso quando è stata accesa)


_scores: list[dict] = []  # classifica della serata (resta dopo un riavvio a metà serata, vedi party)


def _load_scores(data: list) -> None:
    _scores[:] = [s for s in data if isinstance(s, dict) and s.get("singer")]


party.register("scores", lambda: list(_scores), _load_scores)


def _ranking() -> list[dict]:
    """Miglior punteggio di ogni cantante, dal più alto."""
    best: dict[str, dict] = {}
    for s in _scores:
        k = s["singer"].casefold()
        if k not in best or s["score"] > best[k]["score"]:
            best[k] = s
    return sorted(best.values(), key=lambda s: (-s["score"], s["t"]))


TURN_NOTICE = 60.0  # s: «Preparati, tocca a te» quando al brano in corso ne mancano meno di così


@app.get("/api/turn")
def my_turn(first: str = "", last: str = ""):
    """Tocca a questa persona? Lo chiede l'app Android anche a schermo spento, per svegliare il
    telefono con una notifica: "stage" = il suo brano sta suonando, "next" = è il prossimo e manca
    poco, "" = niente."""
    name = people.display_of(first, last) or people.clean(first)
    snap = playlist.snapshot()
    sings = lambda e: bool(e) and name.casefold() in {  # noqa: E731
        (e.get("singer") or "").casefold(),
        (e.get("partner") or "").casefold(),
    }
    now, entries = snap["now_playing"], snap["entries"]
    state, entry = "", None
    if name and sings(now):
        state, entry = "stage", now
    elif name and entries and sings(entries[0]):
        left = _now_remaining() if now else 0.0
        if not now or left <= TURN_NOTICE:
            state, entry = "next", entries[0]
    song = (entry or {}).get("song") or {}
    return {
        "name": name,
        "state": state,
        "entry": (entry or {}).get("id", ""),
        "title": song.get("title", ""),
        "artist": song.get("artist", ""),
    }


@app.get("/api/people")
def get_people():
    """Persone entrate nella festa: nome, cognome e il nome con cui sono chiamate."""
    return {"people": people.public()}


def _rename_scores(old: str, new: str) -> None:
    for s in _scores:
        if s["singer"].casefold() == old.casefold():
            s["singer"] = new
    hub.publish("scores", {"ranking": _ranking()})


# quando arriva un omonimo, chi era già nella festa cambia nome ovunque («Marco» -> «Marco R.»)
for _cb in (
    playlist.rename, competition.rename, avatars.rename, mode.rename_dj, admin.rename, hub.rename, _rename_scores,
    stats.rename,
):
    people.on_rename(_cb)


@app.get("/api/scores")
def scores():
    return {"ranking": _ranking()}


@app.post("/api/scores", dependencies=[Depends(admin.require_control)])
def add_score(req: ScoreReq):
    """Voto d'intonazione a fine brano (lo manda il player sulla TV)."""
    import time

    song = library.get(req.song_id)
    entry = {
        "singer": req.singer.strip()[:40],
        "score": max(0, min(100, int(req.score))),
        "song_id": req.song_id,
        "title": song.title if song else "",
        "t": time.time(),
    }
    label = req.label.strip()[:40]
    ranking = None
    comp_pos = None
    if entry["singer"]:  # senza nome il voto si vede sulla TV ma non entra in classifica
        _scores.append(entry)
        party.changed()
        if req.entry_id:
            stats.score(req.entry_id, entry["singer"], entry["score"])
        ranking = _ranking()
        hub.publish("scores", {"ranking": ranking})
        comp_pos = competition.add_score(
            entry["singer"], entry["song_id"], entry["title"], entry["score"], req.entry_id, _performers(req.entry_id)
        )
        first, last = people.full_of(entry["singer"]) or (entry["singer"], "")
        halloffame.add(first, last, entry["song_id"], entry["title"], entry["score"], entry["t"], entry["singer"])
    pos = next((i + 1 for i, r in enumerate(ranking or []) if r["singer"].casefold() == entry["singer"].casefold() and r["score"] == entry["score"]), None)
    hub.publish("score", entry | {"position": pos, "label": label})
    return {
        "ranking": ranking or _ranking(),
        "position": pos,
        # pannello di fine brano: posizione nella competizione (None se il voto non conta) e
        # classifica da mostrare dopo il voto (competizione accesa) o hall of fame del brano
        "competition_position": comp_pos,
        "competition": competition.enabled(),
        "standings": competition.standings() if competition.enabled() else [],
        "hall_of_fame": halloffame.for_song(req.song_id),
        "t": entry["t"],
    }


def _performers(entry_id: str) -> list[str]:
    """Chi ha cantato l'esibizione (cantante e, nel duetto, chi si è unito): non può votarla."""
    e = playlist.now_playing
    if e and e.id == entry_id:
        return [n for n in (e.singer, e.partner) if n]
    return []


class VoteReq(BaseModel):
    entry_id: str
    voter: str
    stars: int


@app.post("/api/vote")
def audience_vote(req: VoteReq):
    """Voto del pubblico dal telefono (Competizione): da 1 a 5 stelle all'esibizione appena finita."""
    why = competition.vote(req.entry_id, req.voter[:40], req.stars)
    if why:
        raise HTTPException(409, why)
    return competition.public()


# ------------------------------------------------------------------ statistiche della serata
@app.get("/api/stats")
def evening_stats():
    """Riepilogo della serata: più applaudito, miglior intonazione, duetto migliore, chi ha cantato di più."""
    return stats.summary()


@app.get("/api/stats/qr")
def evening_stats_qr():
    """QR code (SVG) che apre il riepilogo sul telefono, da salvare come immagine."""
    url = f"http://{config.lan_ip()}:{config.PORT}/remote?stats=1"
    return {"url": url, "qr_svg": segno.make(url, error="m").svg_inline(
        scale=6, dark="#0b0b14", light="#ffffff", border=2, omitsize=True)}


@app.post("/api/admin/stats/show", dependencies=[Depends(admin.require_control)])
def show_stats():
    """Mostra il riepilogo della serata sulla TV (dal telefono di un amministratore)."""
    hub.publish("show_stats", {})
    return {"ok": True}


# ------------------------------------------------------------------ competizione
class CompetitionReq(BaseModel):
    enabled: bool
    name: str = ""  # chi la accende dal telefono (non conta come «altro partecipante»)


@app.get("/api/competition")
def get_competition():
    return competition.public()


@app.post("/api/admin/competition", dependencies=[Depends(admin.require_control)])
def set_competition(req: CompetitionReq, x_admin_token: str | None = Header(default=None)):
    """Interruttore «Competizione»: dal PC o da un amministratore.

    Si accende solo con un microfono collegato (senza, non ci sono voti d'intonazione) e con altri
    partecipanti collegati dal telefono (oltre a chi la accende). Accesa a playlist in corsa, il
    brano che sta suonando non conta: la classifica parte dal successivo.
    """
    if req.enabled and not competition.enabled():
        if not mics.any_input():
            raise HTTPException(
                409,
                "Nessun microfono rilevato, la modalità competizione può essere attivata solo se viene collegato un microfono.",
            )
        me = {n.strip().casefold() for n in (req.name, admin.name_of(x_admin_token)) if n.strip()}
        if not [u for u in hub.users() if u.casefold() not in me]:
            raise HTTPException(
                409, "La modalità competizione può essere avviata solo se ci sono altri partecipanti connessi."
            )
    now = playlist.now_playing
    out = competition.set_enabled(req.enabled, now.id if now else None)
    voice.apply()  # con la competizione accesa l'autotune si spegne (e il suo comando sparisce)
    return out


@app.post("/api/admin/competition/show", dependencies=[Depends(admin.require_control)])
def show_competition():
    """Classifica in tempo reale per qualche secondo sulla TV (stessa durata del QR code)."""
    if not competition.enabled():
        raise HTTPException(409, "La modalità Competizione non è attiva")
    hub.publish("show_ranking", {"seconds": 10})
    return {"ok": True}


@app.post("/api/admin/fullscreen", dependencies=[Depends(admin.require_control)])
def admin_fullscreen():
    """Un amministratore rimette a schermo intero l'app del PC (es. dopo che qualcuno ha premuto Esc)."""
    hub.publish("fullscreen", {"on": True})
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
        await websocket.send_text(json.dumps({"event": "settings", "data": mode.settings_public()}))
        await websocket.send_text(json.dumps({"event": "competition", "data": competition.public()}, ensure_ascii=False))
        while True:
            msg = await websocket.receive_text()  # "ping" (keep-alive) oppure {"hello": "<nome>"}
            if msg == "ping":
                # il telefono capisce così che il PC c'è ancora (se sparisce, ferma il brano a schermo)
                await websocket.send_text('{"event": "pong", "data": null}')
            elif msg.startswith("{"):
                try:
                    data = json.loads(msg)
                except ValueError:
                    continue
                if isinstance(data, dict) and "hello" in data:
                    hello = data["hello"]
                    if isinstance(hello, dict):
                        # nome e cognome: nella festa ci si chiama per nome (con l'iniziale del
                        # cognome solo se c'è un omonimo)
                        name = people.join(str(hello.get("first") or ""), str(hello.get("last") or ""))
                    else:
                        name = str(hello or "")  # telefono con l'app vecchia: solo il nome
                    hub.set_name(websocket, name)
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


@app.get("/media/{song_id}/key/{semitones}/{name}")
def media_key(song_id: str, semitones: int, name: str):
    """Base o voce guida in un'altra tonalità (stessa velocità): creata al primo uso, poi riusata."""
    song = library.get(song_id)
    if not song or name not in {"instrumental.m4a", "vocals.m4a"} or abs(semitones) > audio.KEY_RANGE:
        raise HTTPException(404)
    src = song.dir / name
    if not src.exists():
        raise HTTPException(404)
    try:
        path = audio.transposed(src, semitones, voice=name == "vocals.m4a")
    except RuntimeError as e:
        raise HTTPException(500, f"Cambio di tonalità non riuscito: {e}")
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


APK = Path(__file__).with_name("static") / "SingITnow.apk"


@app.get("/download/SingITnow.apk", include_in_schema=False)
def android_app():
    """App Android (compilata con android/build.ps1): apre questa pagina a tutto schermo."""
    if not APK.exists():
        raise HTTPException(404, "App Android non disponibile")
    return FileResponse(
        APK,
        media_type="application/vnd.android.package-archive",
        filename="SingITnow.apk",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/join", include_in_schema=False)
def join(request: Request):
    """Indirizzo del QR code. Android (dal browser) → download dell'app; iPhone e altri → pagina.
    Dentro l'app (WebView, "; wv)" nello user agent) si apre sempre la pagina."""
    from fastapi.responses import RedirectResponse

    ua = request.headers.get("user-agent", "")
    if "Android" in ua and "; wv)" not in ua and APK.exists():
        return RedirectResponse("/download/SingITnow.apk", status_code=302)
    return RedirectResponse("/remote", status_code=302)


@app.get("/api/app", include_in_schema=False)
def android_app_info():
    return {"android": APK.exists()}


# effetti sonori (es. l'applauso che la TV fa sentire quando qualcuno applaude dal telefono)
SOUNDS_DIR = config.ROOT_DIR / "media" / "sounds"
if SOUNDS_DIR.exists():
    app.mount("/sounds", StaticFiles(directory=SOUNDS_DIR), name="sounds")

if (config.FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=config.FRONTEND_DIST / "assets"), name="assets")

if config.FRONTEND_DIST.exists():
    # manifest, icone e service worker della PWA
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIST), name="static")
