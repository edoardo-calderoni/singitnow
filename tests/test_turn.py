"""Avvisi a schermo spento (/api/turn): tocca a te, quale microfono prendere, a chi passarlo."""

import pytest
from fastapi.testclient import TestClient

from singitnow import app as appmod
from singitnow import mics
from singitnow.library import READY, Song, library
from singitnow.playlist import Entry, playlist


@pytest.fixture
def serata(monkeypatch):
    """Due brani pronti, due microfoni, coda vuota; `left` = secondi alla fine del brano in corso."""
    for sid in ("s1", "s2"):
        library.add(Song(id=sid, title=f"Brano {sid}", artist="X", youtube_id=sid, status=READY, duration=200))
    monkeypatch.setattr(mics, "list_mics", lambda: [{"index": 0}, {"index": 1}])
    monkeypatch.setattr(appmod, "_mic_count_cache", (0.0, 0))
    left = {"s": 100.0}
    monkeypatch.setattr(appmod, "_now_remaining", lambda: left["s"])
    with playlist._lock:
        playlist._entries.clear()
        playlist.now_playing = None
        playlist.previous = None
    yield left
    with playlist._lock:
        playlist._entries.clear()
        playlist.now_playing = None
        playlist.previous = None


def _set(now: Entry | None, nxt: Entry | None):
    with playlist._lock:
        playlist.now_playing = now
        playlist._entries[:] = [nxt] if nxt else []


def turn(name: str) -> dict:
    return TestClient(appmod.app).get("/api/turn", params={"first": name}).json()


def test_solista_poi_duetto(serata):
    _set(Entry("a", "s1", "Anna"), Entry("b", "s2", "Bruno", partner="Carla"))
    serata["s"] = 30
    assert turn("Bruno")["alert_text"] == "«Brano s2» parte tra poco: prendi il microfono Rosso 🎤"
    assert turn("Carla")["mic"] == "Blu"
    assert turn("Anna")["state"] == "stage"
    serata["s"] = 0  # brano finito: punteggi sulla TV
    a = turn("Anna")
    assert a["state"] == "pass" and a["alert_title"] == "Passa il microfono a Bruno 🎤"
    assert turn("Bruno")["alert_title"] == "Tocca a te! Prendi il microfono Rosso 🎤"
    assert turn("Carla")["alert_title"] == "Tocca a te! Prendi il microfono Blu 🎤"


def test_duetto_poi_solista_passa_solo_il_rosso(serata):
    _set(Entry("a", "s1", "Anna", partner="Bea"), Entry("b", "s2", "Bruno"))
    serata["s"] = 0
    assert turn("Anna")["pass_to"] == "Bruno"
    assert turn("Bea")["state"] == ""


def test_duetto_poi_duetto_passano_tutti_e_due(serata):
    _set(Entry("a", "s1", "Anna", partner="Bea"), Entry("b", "s2", "Bruno", partner="Carla"))
    serata["s"] = 0
    assert turn("Anna")["pass_to"] == "Bruno"
    assert turn("Bea")["pass_to"] == "Carla"


def test_chi_passa_e_canta_ancora(serata):
    _set(Entry("a", "s1", "Anna", partner="Bea"), Entry("b", "s2", "Bea", partner="Carla"))
    serata["s"] = 0
    assert turn("Anna")["pass_to"] == "Bea"
    b = turn("Bea")
    assert b["state"] == "ready" and b["mic"] == "Rosso"
    assert b["alert_text"].startswith("Prima passa il tuo microfono a Carla")


def test_un_solo_microfono_niente_colore(serata, monkeypatch):
    monkeypatch.setattr(mics, "list_mics", lambda: [{"index": 0}])
    _set(Entry("a", "s1", "Anna", partner="Bea"), Entry("b", "s2", "Bruno", partner="Carla"))
    serata["s"] = 0
    assert turn("Bea")["state"] == ""  # col microfono unico passa solo chi ha prenotato
    assert turn("Carla")["alert_title"] == "Tocca a te! Prendi il microfono 🎤"


def test_brano_interrotto_si_passa_quando_parte_il_dopo(serata):
    _set(Entry("a", "s1", "Anna"), Entry("b", "s2", "Bruno"))
    playlist.play(None)  # «Avanti» a metà brano
    a = turn("Anna")
    assert a["state"] == "pass" and a["pass_to"] == "Bruno" and a["alert_id"] == "pass:a"
    assert turn("Bruno")["state"] == "stage"
