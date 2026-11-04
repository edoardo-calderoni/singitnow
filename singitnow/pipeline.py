"""Pipeline di elaborazione: download → separazione voce → testo sincronizzato.

Un singolo thread worker elabora i brani in coda uno alla volta (le operazioni AI sono pesanti).
"""

from __future__ import annotations

import json
import logging
import shutil
import threading
import time
import traceback

import httpx

from . import audio, config, lyrics, youtube
from .library import DOWNLOADING, ERROR, LYRICS, QUEUED, READY, SEPARATING, Song, library

log = logging.getLogger(__name__)

# Pesi delle fasi sulla barra di avanzamento complessiva
P_DOWNLOAD = (0.0, 0.25)
P_SEPARATE = (0.25, 0.60)
P_LYRICS = (0.60, 0.98)


def _span(rng: tuple[float, float], p: float) -> float:
    return rng[0] + (rng[1] - rng[0]) * max(0.0, min(p, 1.0))


class Pipeline:
    def __init__(self) -> None:
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._ready_callbacks: list = []

    def on_ready(self, cb) -> None:
        self._ready_callbacks.append(cb)

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._run, name="pipeline", daemon=True)
            self._thread.start()
        self._wake.set()

    def enqueue(self, youtube_id: str, title: str = "", channel: str = "", duration: float = 0) -> Song:
        existing = library.get(youtube_id)
        if existing:
            if existing.status == ERROR:
                library.update(existing.id, status=QUEUED, progress=0.0, step="In coda", error="")
                self._wake.set()
            return existing
        song = Song(
            id=youtube_id,
            youtube_id=youtube_id,
            title=title or youtube_id,
            artist=channel,
            duration=duration,
            thumbnail=f"https://i.ytimg.com/vi/{youtube_id}/hqdefault.jpg",
            source_url=f"https://www.youtube.com/watch?v={youtube_id}",
        )
        library.add(song)
        self._wake.set()
        return song

    def resync_lyrics(self, song_id: str, artist: str, title: str) -> None:
        """Rigenera il testo (es. dopo aver corretto artista/titolo)."""
        library.update(song_id, artist=artist, title=title)
        threading.Thread(target=self._lyrics_only, args=(song_id,), daemon=True).start()

    # ------------------------------------------------------------------ worker

    def _run(self) -> None:
        while True:
            self._wake.wait()
            self._wake.clear()
            while pending := library.pending():
                self._process(pending[0])

    def _process(self, song: Song) -> None:
        sid = song.id
        work = config.WORK_DIR / sid
        work.mkdir(parents=True, exist_ok=True)
        try:
            vocals_m4a, inst_m4a = song.dir / "vocals.m4a", song.dir / "instrumental.m4a"
            if not (song.dir / "video.mp4").exists():
                self._download(song)
            if not (vocals_m4a.exists() and inst_m4a.exists()):
                self._separate(song, work)

            # 3. Testo sincronizzato
            library.update(sid, status=LYRICS, progress=_span(P_LYRICS, 0), step="Cerco il testo online…")
            self._build_lyrics(sid, vocals_m4a)

            library.update(sid, status=READY, progress=1.0, step="Pronto", error="")
            for cb in self._ready_callbacks:
                try:
                    cb(library.get(sid))
                except Exception:
                    log.exception("callback on_ready")
        except Exception as e:
            log.error("Elaborazione %s fallita:\n%s", sid, traceback.format_exc())
            library.update(sid, status=ERROR, step="Errore", error=str(e)[:400])
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _download(self, song: Song) -> None:
        sid = song.id
        library.update(sid, status=DOWNLOADING, progress=0.01, step="Scarico il video…")
        last = [0.0]

        def dl_progress(p: float) -> None:
            if time.time() - last[0] > 0.5:  # limita gli aggiornamenti
                last[0] = time.time()
                library.update(sid, progress=_span(P_DOWNLOAD, p * 0.95))

        info = youtube.download(song.source_url, song.dir, dl_progress)
        artist, title = youtube.guess_artist_title(info)
        library.update(
            sid,
            title=title or info.get("title") or song.title,
            artist=artist,
            duration=float(info.get("duration") or song.duration or 0),
        )
        self._save_thumbnail(song)

    def _separate(self, song: Song, work) -> None:
        sid = song.id
        library.update(sid, status=SEPARATING, progress=_span(P_SEPARATE, 0), step="Separo la voce dalla musica…")
        wav = audio.extract_wav(song.dir / "video.mp4", work / "mix.wav")
        stop = threading.Event()
        threading.Thread(target=self._ticker, args=(sid, P_SEPARATE, song.duration or 240, stop), daemon=True).start()
        try:
            vocals_wav, inst_wav = audio.separate(wav, work)
        finally:
            stop.set()
        library.update(sid, progress=_span(P_SEPARATE, 0.97), step="Preparo le tracce audio…")
        audio.to_m4a(vocals_wav, song.dir / "vocals.m4a")
        audio.to_m4a(inst_wav, song.dir / "instrumental.m4a")

    def _build_lyrics(self, sid: str, vocals_path) -> None:
        s = library.get(sid)
        data = lyrics.build(
            vocals_path,
            s.artist,
            s.title,
            s.duration,
            lambda p, msg: library.update(sid, progress=_span(P_LYRICS, p), step=msg),
        )
        (s.dir / "lyrics.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        library.update(sid, lyrics_source=data["source"], language=data.get("language", ""))

    def _lyrics_only(self, sid: str) -> None:
        song = library.get(sid)
        if not song:
            return
        prev = song.status
        try:
            library.update(sid, status=LYRICS, progress=_span(P_LYRICS, 0), step="Rigenero il testo…")
            self._build_lyrics(sid, song.dir / "vocals.m4a")
            library.update(sid, status=READY, progress=1.0, step="Pronto")
        except Exception as e:
            log.exception("Rigenerazione testo fallita")
            library.update(sid, status=prev, step="Pronto", error=f"Testo: {e}"[:400])

    @staticmethod
    def _ticker(sid: str, rng, duration: float, stop: threading.Event) -> None:
        """La separazione non espone l'avanzamento: lo stimiamo dal tempo trascorso."""
        expected = max(30.0, duration * 0.5)  # stima prudente su CPU
        t0 = time.time()
        while not stop.wait(1.0):
            p = 1 - pow(2.71828, -(time.time() - t0) / expected)
            library.update(sid, progress=_span(rng, p * 0.95))

    @staticmethod
    def _save_thumbnail(song: Song) -> None:
        try:
            r = httpx.get(song.thumbnail, timeout=10, follow_redirects=True)
            if r.status_code == 200:
                (song.dir / "thumb.jpg").write_bytes(r.content)
        except httpx.HTTPError:
            pass


pipeline = Pipeline()
