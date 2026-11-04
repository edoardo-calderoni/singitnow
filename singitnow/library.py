"""Libreria brani: ogni brano vive in data/library/<id>/ con song.json e i file media."""

from __future__ import annotations

import json
import shutil
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from . import config
from .events import hub

# Stati della pipeline di elaborazione
QUEUED = "queued"
DOWNLOADING = "downloading"
SEPARATING = "separating"
LYRICS = "lyrics"
READY = "ready"
ERROR = "error"


@dataclass
class Song:
    id: str
    youtube_id: str
    title: str
    artist: str = ""
    duration: float = 0.0
    thumbnail: str = ""
    source_url: str = ""
    status: str = QUEUED
    progress: float = 0.0
    step: str = "In coda"
    error: str = ""
    lyrics_source: str = ""
    language: str = ""
    created_at: float = field(default_factory=time.time)

    @property
    def dir(self) -> Path:
        return config.LIBRARY_DIR / self.id

    def to_public(self) -> dict[str, Any]:
        d = asdict(self)
        base = f"/media/{self.id}"
        has_thumb = (self.dir / "thumb.jpg").exists()
        d["thumbnail_url"] = f"{base}/thumb.jpg" if has_thumb else self.thumbnail
        if self.status == READY:
            d["media"] = {
                "video": f"{base}/video.mp4",
                "instrumental": f"{base}/instrumental.m4a",
                "vocals": f"{base}/vocals.m4a",
                "lyrics": f"/api/songs/{self.id}/lyrics",
            }
        return d


class Library:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._songs: dict[str, Song] = {}

    def load(self) -> None:
        config.ensure_dirs()
        with self._lock:
            self._songs.clear()
            for meta in config.LIBRARY_DIR.glob("*/song.json"):
                try:
                    raw = json.loads(meta.read_text(encoding="utf-8"))
                    known = {k: v for k, v in raw.items() if k in Song.__dataclass_fields__}
                    song = Song(**known)
                except Exception:
                    continue
                # Un'elaborazione interrotta (app chiusa) va ripresa da capo.
                if song.status not in (READY, ERROR):
                    song.status, song.progress, song.step = QUEUED, 0.0, "In coda"
                self._songs[song.id] = song

    def all(self) -> list[Song]:
        with self._lock:
            return sorted(self._songs.values(), key=lambda s: s.created_at, reverse=True)

    def get(self, song_id: str) -> Song | None:
        with self._lock:
            return self._songs.get(song_id)

    def pending(self) -> list[Song]:
        with self._lock:
            return sorted(
                (s for s in self._songs.values() if s.status == QUEUED),
                key=lambda s: s.created_at,
            )

    def add(self, song: Song) -> Song:
        with self._lock:
            song.dir.mkdir(parents=True, exist_ok=True)
            self._songs[song.id] = song
            self._save(song)
        hub.publish("song", song.to_public())
        return song

    def update(self, song_id: str, **changes: Any) -> Song | None:
        with self._lock:
            song = self._songs.get(song_id)
            if song is None:
                return None
            for k, v in changes.items():
                setattr(song, k, v)
            self._save(song)
        hub.publish("song", song.to_public())
        return song

    def remove(self, song_id: str) -> bool:
        with self._lock:
            song = self._songs.pop(song_id, None)
        if song is None:
            return False
        shutil.rmtree(song.dir, ignore_errors=True)
        hub.publish("song_removed", {"id": song_id})
        return True

    def _save(self, song: Song) -> None:
        tmp = song.dir / "song.json.tmp"
        tmp.write_text(json.dumps(asdict(song), ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(song.dir / "song.json")


library = Library()
