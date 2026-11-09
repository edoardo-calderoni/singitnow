"""Registrazioni delle esibizioni: solo chi ha cantato le vede e le scarica."""

from __future__ import annotations

import time

import pytest

from singitnow import recordings


@pytest.fixture(autouse=True)
def no_convert(monkeypatch):
    monkeypatch.setattr(recordings, "_convert", lambda rid: None)  # niente ffmpeg nei test


def meta(**kw):
    return {"song_id": "a", "title": "Brano A", "artist": "X", "seconds": 180,
            "performers": [("Anna", "Verdi", "Anna"), ("Bruno", "Neri", "Bruno")]} | kw


def test_solo_chi_ha_cantato_vede_e_scarica():
    info = recordings.save(b"webm", meta())
    assert [r["id"] for r in recordings.for_person("anna", "verdi")] == [info["id"]]
    assert [r["id"] for r in recordings.for_person("Bruno", "Neri")] == [info["id"]]
    assert recordings.for_person("Carla", "Bianchi") == []
    path, name = recordings.file(info["id"], "Anna", "Verdi")
    assert path.read_bytes() == b"webm"
    assert name.startswith("Brano A - Anna e Bruno ") and name.endswith(".webm")
    assert recordings.file(info["id"], "Carla", "Bianchi") is None
    assert recordings.file("../../etc", "Anna", "Verdi") is None


def test_troppo_corta_o_vuota():
    with pytest.raises(ValueError):
        recordings.save(b"webm", meta(seconds=10))
    with pytest.raises(ValueError):
        recordings.save(b"", meta())


def test_cancellazione_e_pulizia():
    a = recordings.save(b"1", meta())
    b = recordings.save(b"2", meta())
    assert not recordings.delete(a["id"], "Carla", "Bianchi")
    assert recordings.delete(a["id"], "Anna", "Verdi")
    assert [r["id"] for r in recordings.for_person("Anna", "Verdi")] == [b["id"]]
    assert recordings.cleanup(now=time.time() + recordings.KEEP_DAYS * 86400 + 1) == 1
    assert recordings.for_person("Anna", "Verdi") == []
