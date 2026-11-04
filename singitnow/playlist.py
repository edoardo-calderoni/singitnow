"""Playlist della serata: chi canta cosa, in che ordine."""

from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field

from . import config
from .events import hub
from .library import READY, Song, library


@dataclass
class Entry:
    id: str
    song_id: str
    singer: str
    added_at: float = field(default_factory=time.time)


class Playlist:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._entries: list[Entry] = []
        self.now_playing: Entry | None = None
        # Richieste di brani non ancora in libreria: song_id -> cantanti in attesa
        self._waiting: dict[str, list[str]] = {}
        self._file = config.DATA_DIR / "playlist.json"

    # -------------------------------------------------------------- persistenza
    def load(self) -> None:
        try:
            raw = json.loads(self._file.read_text(encoding="utf-8"))
            self._entries = [Entry(**e) for e in raw.get("entries", [])]
            self._waiting = raw.get("waiting", {})
        except (FileNotFoundError, ValueError, TypeError):
            pass

    def _save(self) -> None:
        data = {"entries": [asdict(e) for e in self._entries], "waiting": self._waiting}
        self._file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def _changed(self) -> None:
        self._save()
        hub.publish("playlist", self.snapshot())

    # -------------------------------------------------------------- lettura
    def snapshot(self) -> dict:
        with self._lock:
            def pub(e: Entry | None):
                if e is None:
                    return None
                s = library.get(e.song_id)
                return asdict(e) | {"song": s.to_public() if s else None}

            waiting = []
            for sid, singers in self._waiting.items():
                s = library.get(sid)
                for singer in singers:
                    waiting.append({"song_id": sid, "singer": singer, "song": s.to_public() if s else None})
            return {
                "now_playing": pub(self.now_playing),
                "entries": [pub(e) for e in self._entries if library.get(e.song_id)],
                "waiting": waiting,
            }

    # -------------------------------------------------------------- modifica
    def add(self, song_id: str, singer: str) -> None:
        singer = singer.strip()[:40] or "Ospite"
        with self._lock:
            song = library.get(song_id)
            if song and song.status == READY:
                self._entries.append(Entry(uuid.uuid4().hex[:10], song_id, singer))
            else:
                self._waiting.setdefault(song_id, []).append(singer)
            self._changed()

    def song_ready(self, song: Song | None) -> None:
        if song is None:
            return
        with self._lock:
            singers = self._waiting.pop(song.id, [])
            for singer in singers:
                self._entries.append(Entry(uuid.uuid4().hex[:10], song.id, singer))
        if singers:
            self._changed()
        else:
            hub.publish("playlist", self.snapshot())

    def remove(self, entry_id: str) -> None:
        with self._lock:
            self._entries = [e for e in self._entries if e.id != entry_id]
            self._changed()

    def move(self, entry_id: str, delta: int) -> None:
        with self._lock:
            idx = next((i for i, e in enumerate(self._entries) if e.id == entry_id), None)
            if idx is None:
                return
            new = max(0, min(len(self._entries) - 1, idx + delta))
            self._entries.insert(new, self._entries.pop(idx))
            self._changed()

    def play(self, entry_id: str | None = None) -> Entry | None:
        """Avvia la voce indicata (o la prima in coda) togliendola dalla coda."""
        with self._lock:
            if entry_id:
                entry = next((e for e in self._entries if e.id == entry_id), None)
            else:
                entry = next((e for e in self._entries if library.get(e.song_id)), None)
            if entry:
                self._entries.remove(entry)
            self.now_playing = entry
            self._changed()
            return entry

    def play_song(self, song_id: str, singer: str = "") -> Entry:
        with self._lock:
            self.now_playing = Entry(uuid.uuid4().hex[:10], song_id, singer)
            self._changed()
            return self.now_playing

    def stop(self) -> None:
        with self._lock:
            self.now_playing = None
            self._changed()

    def forget_song(self, song_id: str) -> None:
        with self._lock:
            self._entries = [e for e in self._entries if e.song_id != song_id]
            self._waiting.pop(song_id, None)
            self._changed()


playlist = Playlist()
