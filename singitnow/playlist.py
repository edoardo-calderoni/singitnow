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
    auto: bool = False  # avviata automaticamente (playlist ferma): la TV passa a schermo intero


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

    def _autostart(self) -> Entry | None:
        """Se non sta suonando niente, la prima richiesta in coda parte subito (da chiamare col lock)."""
        if self.now_playing is not None or not self._entries:
            return None
        entry = self._entries.pop(0)
        entry.auto = True
        self.now_playing = entry
        return entry

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
    def has_pending(self, singer: str) -> bool:
        """True se `singer` ha già un brano in coda (pronto o ancora in preparazione)."""
        k = singer.strip().casefold()
        if not k:
            return False
        with self._lock:
            return any(e.singer.strip().casefold() == k for e in self._entries) or any(
                n.strip().casefold() == k for names in self._waiting.values() for n in names
            )

    def add(self, song_id: str, singer: str) -> None:
        singer = singer.strip()[:40] or "Ospite"
        with self._lock:
            song = library.get(song_id)
            if song and song.status == READY:
                self._entries.append(Entry(uuid.uuid4().hex[:10], song_id, singer))
                position = -1 if self._autostart() else len(self._entries)  # -1 = parte subito
            else:
                self._waiting.setdefault(song_id, []).append(singer)
                position = 0  # in preparazione
            self._changed()
        # Avviso sulla TV: "Richiesta di <nome>"
        hub.publish("request", {"singer": singer, "position": position, "song": song.to_public() if song else None})

    def song_ready(self, song: Song | None) -> None:
        if song is None:
            return
        with self._lock:
            singers = self._waiting.pop(song.id, [])
            for singer in singers:
                self._entries.append(Entry(uuid.uuid4().hex[:10], song.id, singer))
            if singers:
                self._autostart()
        if singers:
            self._changed()
        else:
            hub.publish("playlist", self.snapshot())

    def singer_of(self, entry_id: str) -> str | None:
        """Chi ha prenotato la voce in coda (None se non c'è)."""
        with self._lock:
            return next((e.singer for e in self._entries if e.id == entry_id), None)

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

    def remove_waiting(self, song_id: str, singer: str) -> None:
        """Annulla la prenotazione di un brano ancora in preparazione."""
        with self._lock:
            singers = self._waiting.get(song_id, [])
            if singer in singers:
                singers.remove(singer)  # una sola prenotazione per volta
                if not singers:
                    self._waiting.pop(song_id, None)
                self._changed()

    def forget_song(self, song_id: str) -> None:
        with self._lock:
            self._entries = [e for e in self._entries if e.song_id != song_id]
            self._waiting.pop(song_id, None)
            self._changed()


playlist = Playlist()
