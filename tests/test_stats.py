"""Statistiche della serata."""

from __future__ import annotations

import pytest

from singitnow import stats


@pytest.fixture(autouse=True)
def clean():
    stats.reset()
    yield
    stats.reset()


def test_riepilogo_della_serata():
    stats.started("e1", "a", "Brano A", "X", "Anna")
    stats.started("e2", "b", "Brano B", "Y", "Bruno", partner="Carla")
    stats.started("e3", "c", "Brano C", "Z", "Anna")
    for _ in range(5):
        stats.applause("e2")
    stats.applause("e1")
    stats.score("e1", "Anna", 70)
    stats.score("e2", "Bruno", 88)
    stats.score("e2", "Carla", 92)
    stats.score("e3", "Anna", 75)

    s = stats.summary()
    assert s["performances"] == 3 and s["singers"] == 3 and s["applause"] == 6
    assert s["most_applauded"]["title"] == "Brano B" and s["most_applauded"]["singers"] == ["Bruno", "Carla"]
    assert s["best_pitch"] == {"singer": "Carla", "score": 92, "title": "Brano B", "song_id": "b"}
    assert s["best_duet"]["title"] == "Brano B"
    assert s["most_songs"] == {"singers": ["Anna"], "count": 2}


def test_senza_cantante_non_e_un_esibizione():
    stats.started("e1", "a", "Brano A", "X", "")
    s = stats.summary()
    assert s["performances"] == 0 and s["most_applauded"] is None and s["most_songs"] is None


def test_esibizione_contata_una_volta_e_cambio_nome():
    stats.started("e1", "a", "Brano A", "X", "Marco")
    stats.started("e1", "a", "Brano A", "X", "Marco")
    stats.score("e1", "Marco", 80)
    stats.rename("Marco", "Marco R.")
    s = stats.summary()
    assert s["performances"] == 1
    assert s["best_pitch"]["singer"] == "Marco R."
    assert s["most_songs"]["singers"] == ["Marco R."]


def test_le_esibizioni_partono_con_il_brano(add_song):
    from singitnow.playlist import Playlist

    add_song("a")
    Playlist().add("a", "Anna")
    assert stats.summary()["performances"] == 1
