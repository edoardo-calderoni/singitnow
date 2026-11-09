"""Tonalità consigliata: estensione della voce, trasposizione più comoda, «Adatta la tua tonalità»."""

from __future__ import annotations

import json

import numpy as np
import pytest

from singitnow import keyfit, mode
from singitnow.playlist import Playlist


@pytest.fixture(autouse=True)
def no_prepare(monkeypatch):
    """Niente ffmpeg nei test: la preparazione della tonalità in sottofondo si salta."""
    monkeypatch.setattr(keyfit, "prepare", lambda song_id, semitones: None)
    keyfit._cache.clear()
    keyfit._melodies.clear()


def melody(song, notes):
    (song.dir / "pitch.json").write_text(json.dumps({"version": 6, "notes": notes}), encoding="utf-8")


def flat(midi_values):
    return [[i, i + 0.8, m] for i, m in enumerate(midi_values)]


VOICE = {"lo": 55.0, "mid": 60.0, "hi": 65.0}  # da Sol3 a Fa4, centro Do4


# ------------------------------------------------------------------ calcolo
def test_melodia_gia_dentro_la_voce_resta_originale():
    midi = np.array([57, 59, 60, 62, 64, 60, 59], float)
    assert keyfit.best_shift(midi, np.ones_like(midi), VOICE) == 0


def test_melodia_troppo_alta_si_abbassa():
    midi = np.array([60, 62, 64, 65, 67, 69, 70] * 3, float)  # arriva al La#4
    k = keyfit.best_shift(midi, np.ones_like(midi), VOICE)
    assert -6 <= k < 0
    shifted = midi + k
    assert shifted.max() <= VOICE["hi"] + 1


def test_un_ottava_sotto_va_bene_lo_stesso():
    midi = np.array([69, 71, 72, 74, 76, 72, 71], float)  # la stessa melodia un'ottava sopra
    assert keyfit.best_shift(midi, np.ones_like(midi), VOICE) == 0


def test_esibizioni_brevi_o_assurde_non_contano():
    assert not keyfit.add("Anna", "Rossi", 55, 60, 65, seconds=5)
    assert not keyfit.add("Anna", "Rossi", 65, 60, 55, seconds=60)
    assert keyfit.voice("Anna", "Rossi") is None
    assert keyfit.add("Anna", "Rossi", 55, 60, 65, seconds=60)
    assert keyfit.voice("Anna", "Rossi")["mid"] == 60


def test_si_ricordano_solo_le_ultime_esibizioni():
    for i in range(keyfit.KEEP + 5):
        keyfit.add("Anna", "", 40 + i, 45 + i, 50 + i, seconds=30)
    assert keyfit.voice("Anna", "")["count"] == keyfit.KEEP


# ------------------------------------------------------------------ in coda
def high_song(add_song, song_id="a"):
    song = add_song(song_id)
    melody(song, flat([60, 62, 64, 65, 67, 69, 70] * 3))
    return song


def test_senza_voce_conosciuta_nessun_consiglio(add_song):
    high_song(add_song)
    pl = Playlist()
    pl.add("a", "Anna", autostart=False, from_pc=True)
    e = pl.snapshot()["entries"][0]
    assert e["suggested_key"] is None and e["play_key"] == 0


def test_consiglio_e_adatta_la_tua_tonalita(add_song):
    high_song(add_song)
    keyfit.add("Anna", "", **VOICE, seconds=60)
    pl = Playlist()
    pl.add("a", "Anna", autostart=False, from_pc=True)
    e = pl.snapshot()["entries"][0]
    assert e["suggested_key"] < 0
    assert e["play_key"] == 0  # senza adattamento automatico parte nell'originale

    assert pl.set_key(e["id"], "Marco", None)[0]  # non è il suo brano
    err, now = pl.set_key(e["id"], "anna", None)
    assert err == "" and now is None  # non sta ancora suonando
    e = pl.snapshot()["entries"][0]
    assert e["play_key"] == e["suggested_key"] == e["key"]

    pl.set_key(e["id"], "Anna", 0)  # «Originale»
    assert pl.snapshot()["entries"][0]["play_key"] == 0


def test_adattamento_automatico(add_song):
    high_song(add_song)
    keyfit.add("Anna", "", **VOICE, seconds=60)
    mode.set_auto_key(True)
    try:
        pl = Playlist()
        pl.add("a", "Anna", autostart=False, from_pc=True)
        e = pl.snapshot()["entries"][0]
        assert e["play_key"] == e["suggested_key"] < 0
        pl.set_key(e["id"], "Anna", 0)  # chi canta preferisce l'originale: vince la sua scelta
        assert pl.snapshot()["entries"][0]["play_key"] == 0
    finally:
        mode.set_auto_key(False)


def test_niente_consiglio_in_duetto_o_in_jukebox(add_song):
    high_song(add_song)
    keyfit.add("Anna", "", **VOICE, seconds=60)
    pl = Playlist()
    pl.add("a", "Anna", autostart=False, from_pc=True)
    pl._entries[0].partner = "Marco"
    assert pl.snapshot()["entries"][0]["suggested_key"] is None
    pl._entries[0].partner = ""
    mode.set_mode(mode.JUKEBOX)
    try:
        assert pl.snapshot()["entries"][0]["suggested_key"] is None
    finally:
        mode.set_mode(mode.KARAOKE)
