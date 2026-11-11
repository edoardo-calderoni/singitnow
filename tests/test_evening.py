"""«Concludi la serata»: l'ultimo brano, la chiusura e la serata nuova."""

from __future__ import annotations

import pytest

from singitnow import competition, evening, stats
from singitnow.events import hub
from singitnow.playlist import Playlist


@pytest.fixture
def pl():
    return Playlist()


@pytest.fixture
def events(monkeypatch):
    seen = []
    orig = hub.publish
    monkeypatch.setattr(hub, "publish", lambda ev, data=None: (seen.append((ev, data)), orig(ev, data))[1])
    return seen


def _queue(pl, add_song, *ids):
    for i in ids:
        add_song(i)
        pl.add(i, f"Cantante {i}")


def test_l_ultimo_e_il_primo_in_coda(pl, add_song, events):
    _queue(pl, add_song, "a", "b", "c")  # «a» suona, in coda «b» e «c»
    assert evening.close(pl.now_playing.id, pl.upcoming()) is False
    last = pl._entries[0].id
    assert evening.is_last(last)
    pl.play(None)  # finito «a» parte «b», l'ultimo
    assert pl.now_playing.id == last
    assert pl.play(None) is None  # finito «b» non si va avanti: la serata si chiude
    assert pl.now_playing is None
    assert [e.song_id for e in pl._entries] == ["c"]  # il resto della coda resta lì
    assert evening.ended() and not evening.closing()
    assert any(ev == "evening_end" for ev, _ in events)


def test_coda_vuota_l_ultimo_e_quello_che_suona(pl, add_song):
    _queue(pl, add_song, "a")
    evening.close(pl.now_playing.id, pl.upcoming())
    assert evening.is_last(pl.now_playing.id)
    pl.stop()  # anche fermandolo la serata si conclude
    assert evening.ended()


def test_senza_musica_si_chiude_subito():
    assert evening.close(None, []) is True
    assert evening.ended()


def test_annullare_la_chiusura(pl, add_song):
    _queue(pl, add_song, "a", "b")
    evening.close(pl.now_playing.id, pl.upcoming())
    evening.cancel()
    pl.play(None)
    assert pl.play(None) is None and not evening.ended()  # coda finita, ma la serata continua


def test_ultimo_tolto_dalla_coda_diventa_ultimo_il_successivo(pl, add_song):
    _queue(pl, add_song, "a", "b", "c")
    evening.close(pl.now_playing.id, pl.upcoming())
    pl.remove(pl._entries[0].id)  # «b» tolto dalla coda
    pl.play(None)  # parte «c»
    assert evening.is_last(pl.now_playing.id)


def test_dopo_la_fine_la_musica_non_riparte_da_sola_e_poi_serata_nuova(pl, add_song):
    _queue(pl, add_song, "a")
    competition.add_score("Cantante a", "a", "A", 80)
    evening.close(pl.now_playing.id, pl.upcoming())
    pl.stop()
    add_song("z")
    pl.add("z", "Zoe")  # dal telefono: a serata conclusa non parte da sola
    assert pl.now_playing is None
    assert competition.standings()  # la classifica della serata finita si vede ancora
    pl.play(None)  # un amministratore riavvia: serata nuova
    assert pl.now_playing.song_id == "z"
    assert not evening.ended()
    assert competition.standings() == []
    assert [s["song_id"] for s in stats._shows] == ["z"]
