"""Ambiente dei test: dati in una cartella temporanea, mai in data/ della libreria vera."""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

# Va impostata prima di importare singitnow: config legge i percorsi all'import.
_DATA = Path(tempfile.mkdtemp(prefix="singitnow-test-"))
os.environ["SINGITNOW_DATA"] = str(_DATA)
os.environ.pop("SINGITNOW_ADMIN_PASSWORD", None)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from singitnow import competition, config, party  # noqa: E402
from singitnow.library import READY, Song, library  # noqa: E402


@pytest.fixture(autouse=True)
def clean_state():
    """Ogni test parte da cartella dati vuota, libreria vuota e nessuna sessione di competizione."""
    shutil.rmtree(config.DATA_DIR, ignore_errors=True)
    config.ensure_dirs()
    with library._lock:
        library._songs.clear()
    with competition._lock:
        competition._results.clear()
        competition._active = False
        competition._excluded = ""
        if competition._end_timer:
            competition._end_timer.cancel()
        competition._end_timer = None
    with party._lock:
        if party._timer:
            party._timer.cancel()
        party._timer = None
    yield


@pytest.fixture
def add_song():
    """Mette un brano in libreria (senza file media). status: READY o uno stato di elaborazione."""

    def make(song_id: str, status: str = READY, duration: float = 200.0, title: str = "") -> Song:
        song = Song(id=song_id, youtube_id=song_id, title=title or f"Brano {song_id}", duration=duration, status=status)
        song.dir.mkdir(parents=True, exist_ok=True)
        with library._lock:
            library._songs[song_id] = song
        return song

    return make


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_DATA, ignore_errors=True)
