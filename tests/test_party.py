"""Ripresa dopo un crash: la serata (partecipanti, competizione, brano in corso) torna com'era."""

from __future__ import annotations

import json

import pytest

from singitnow import competition, config, party, people
from singitnow.playlist import Playlist


@pytest.fixture(autouse=True)
def clean_people():
    with people._lock:
        people._people.clear()
        people._display.clear()
    yield
    with people._lock:
        people._people.clear()
        people._display.clear()


def test_partecipanti_e_competizione_tornano_dopo_un_crash():
    people.join("Marco", "Rossi")
    people.join("Marco", "Bianchi")  # omonimo: diventano «Marco R.» e «Marco B.»
    competition.add_score("Marco R.", "a", "Brano A", 80)
    party.save()

    # l'app si chiude di colpo: in memoria non resta niente
    with people._lock:
        people._people.clear()
        people._display.clear()
    competition._results.clear()

    assert party.restore()
    assert people.display_of("Marco", "Rossi") == "Marco R."
    assert people.display_of("Marco", "Bianchi") == "Marco B."
    assert [r["singer"] for r in competition.standings()] == ["Marco R."]


def test_serata_vecchia_non_si_riprende():
    people.join("Anna", "Verdi")
    party.save()
    with people._lock:
        people._people.clear()
        people._display.clear()
    data = json.loads((config.DATA_DIR / "party.json").read_text(encoding="utf-8"))
    assert not party.restore(now=data["saved_at"] + party.PARTY_TTL + 1)
    assert people.display_of("Anna", "Verdi") == ""


def test_il_brano_che_suonava_torna_in_cima_alla_coda(add_song):
    add_song("a")
    add_song("b")
    pl = Playlist()
    pl.add("a", "Anna")  # parte subito
    pl.add("b", "Bruno")
    assert pl.now_playing.singer == "Anna"

    again = Playlist()  # riavvio
    again.load()
    assert again.now_playing is None
    assert [e.singer for e in again._entries] == ["Anna", "Bruno"]
    assert not again._entries[0].auto
