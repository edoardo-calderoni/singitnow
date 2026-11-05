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

from . import audio, config, covers, lyrics, youtube
from .library import DOWNLOADING, ERROR, LYRICS, QUEUED, READY, SEPARATING, Song, library

log = logging.getLogger(__name__)

# Pesi delle fasi sulla barra di avanzamento complessiva
P_DOWNLOAD = (0.0, 0.25)
P_SEPARATE = (0.25, 0.60)
P_LYRICS = (0.60, 0.98)


class Timing:
    """Durata tipica di ogni fase su questo PC, imparata dai brani già elaborati.

    download: secondi assoluti (dipende dalla rete); separate/lyrics: secondi per secondo di audio.
    """

    DEFAULTS = {"download": 20.0, "separate": 0.45, "lyrics": 0.25}

    def __init__(self) -> None:
        self._path = config.DATA_DIR / "timing.json"
        self._v = dict(self.DEFAULTS)
        try:
            self._v.update(json.loads(self._path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass

    def expected(self, phase: str, duration: float) -> float:
        v = self._v[phase]
        return v if phase == "download" else v * duration

    def record(self, phase: str, seconds: float, duration: float) -> None:
        value = seconds if phase == "download" else seconds / max(duration, 1.0)
        self._v[phase] = 0.5 * self._v[phase] + 0.5 * value  # media mobile: si adatta in pochi brani
        try:
            self._path.write_text(json.dumps(self._v), encoding="utf-8")
        except OSError:
            pass


PHASES = ("download", "separate", "lyrics")


def _span(rng: tuple[float, float], p: float) -> float:
    return rng[0] + (rng[1] - rng[0]) * max(0.0, min(p, 1.0))


class Pipeline:
    def __init__(self) -> None:
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._ready_callbacks: list = []
        self._timing = Timing()
        # fase in corso del brano in elaborazione: nome, inizio, avanzamento noto (0..1 o None)
        self._phase: dict = {}

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
        threading.Thread(target=self._fetch_cover, args=(song_id, True), daemon=True).start()

    def backfill_covers(self) -> None:
        """All'avvio cerca la copertina dei brani che non l'hanno ancora (una volta sola)."""

        def run() -> None:
            for s in library.all():
                if s.status == READY and not (s.dir / "cover.jpg").exists() and not (s.dir / "cover.none").exists():
                    self._fetch_cover(s.id)

        threading.Thread(target=run, name="covers", daemon=True).start()

    @staticmethod
    def _fetch_cover(sid: str, retry: bool = False) -> None:
        """Copertina del disco: se non si trova ne prende nota per non riprovare a ogni avvio."""
        s = library.get(sid)
        if not s:
            return
        marker = s.dir / "cover.none"
        if retry:
            marker.unlink(missing_ok=True)
        elif (s.dir / "cover.jpg").exists() or marker.exists():
            return
        if covers.fetch_cover(s.artist, s.title, s.dir / "cover.jpg"):
            library.update(sid)  # notifica i client: ora c'è cover_url
        else:
            marker.touch()

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
        vocals_m4a, inst_m4a = song.dir / "vocals.m4a", song.dir / "instrumental.m4a"
        todo = [
            ph
            for ph, needed in (
                ("download", not (song.dir / "video.mp4").exists()),
                ("separate", not (vocals_m4a.exists() and inst_m4a.exists())),
                ("lyrics", True),
            )
            if needed
        ]
        stop = threading.Event()
        threading.Thread(target=self._eta_ticker, args=(sid, todo, stop), daemon=True).start()
        try:
            if "download" in todo:
                self._run_phase(sid, "download", lambda: self._download(song))
            if "separate" in todo:
                self._run_phase(sid, "separate", lambda: self._separate(song, work))

            self._fetch_cover(sid)

            # 3. Testo sincronizzato
            library.update(sid, status=LYRICS, progress=_span(P_LYRICS, 0), step="Cerco il testo online…")
            self._run_phase(sid, "lyrics", lambda: self._build_lyrics(sid, vocals_m4a))

            stop.set()
            library.update(sid, status=READY, progress=1.0, step="Pronto", error="", eta=0.0)
            for cb in self._ready_callbacks:
                try:
                    cb(library.get(sid))
                except Exception:
                    log.exception("callback on_ready")
        except Exception as e:
            log.error("Elaborazione %s fallita:\n%s", sid, traceback.format_exc())
            stop.set()
            library.update(sid, status=ERROR, step="Errore", error=str(e)[:400], eta=0.0)
        finally:
            stop.set()
            self._phase = {}
            shutil.rmtree(work, ignore_errors=True)

    def _run_phase(self, sid: str, phase: str, fn) -> None:
        self._phase = {"name": phase, "t0": time.time(), "p": None}
        fn()
        s = library.get(sid)
        self._timing.record(phase, time.time() - self._phase["t0"], (s.duration if s else 0) or 240)

    def _report(self, p: float) -> None:
        """Avanzamento reale (0..1) della fase in corso, se lo strumento lo fornisce."""
        if self._phase:
            self._phase["p"] = p

    def _eta_ticker(self, sid: str, todo: list[str], stop: threading.Event) -> None:
        """Ogni secondo stima quanto manca alla fine dell'elaborazione."""
        shown = None
        while not stop.wait(1.0):
            ph, s = self._phase, library.get(sid)
            if not ph or not s:
                continue
            dur = s.duration or 240
            elapsed = time.time() - ph["t0"]
            expected = self._timing.expected(ph["name"], dur)
            p = ph["p"]
            if p is not None and p > 0.15 and elapsed > 3:
                remaining = elapsed * (1 - p) / p  # stima dalla velocità reale
            else:
                remaining = expected - elapsed
            remaining = max(remaining, 0.08 * expected, 3.0)  # se sfora, "quasi finito" ma mai zero
            later = PHASES[PHASES.index(ph["name"]) + 1 :]
            remaining += sum(self._timing.expected(x, dur) for x in later if x in todo)
            # attenua i salti: la stima scende di un secondo al secondo e si corregge gradualmente
            shown = remaining if shown is None else 0.6 * (shown - 1.0) + 0.4 * remaining
            try:
                library.update(sid, eta=round(max(shown, 1.0), 1))
            except Exception:  # un errore occasionale non deve fermare la stima per tutto il brano
                log.exception("Aggiornamento tempo residuo")

    def _download(self, song: Song) -> None:
        sid = song.id
        library.update(sid, status=DOWNLOADING, progress=0.01, step="Scarico il video…")
        last = [0.0]

        def dl_progress(p: float) -> None:
            if time.time() - last[0] > 0.5:  # limita gli aggiornamenti
                last[0] = time.time()
                self._report(p)
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
            lambda p, msg: (self._report(p), library.update(sid, progress=_span(P_LYRICS, p), step=msg)),
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
        expected = max(30.0, duration * 0.5)  # solo per la barra: il tempo residuo usa Timing
        t0 = time.time()
        while not stop.wait(1.0):
            p = 1 - pow(2.71828, -(time.time() - t0) / expected)
            library.update(sid, progress=_span(rng, p * 0.95))

    @staticmethod
    def _save_thumbnail(song: Song) -> None:
        """Fotogramma del video (ripiego se manca la copertina del disco).

        Preferisce maxresdefault (16:9 pieno); hqdefault ha bande nere sopra e sotto.
        """
        base = f"https://i.ytimg.com/vi/{song.youtube_id}"
        for name in ("maxresdefault.jpg", "sddefault.jpg", "hqdefault.jpg"):
            try:
                r = httpx.get(f"{base}/{name}", timeout=10, follow_redirects=True)
            except httpx.HTTPError:
                continue
            # YouTube risponde 404 (o un segnaposto minuscolo) se quella risoluzione non esiste
            if r.status_code == 200 and len(r.content) > 5000:
                (song.dir / "thumb.jpg").write_bytes(r.content)
                return


pipeline = Pipeline()
