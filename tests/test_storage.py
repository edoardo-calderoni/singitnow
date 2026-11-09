"""Spazio su disco: occupazione dei brani e pulizia delle tonalità trasposte."""

from __future__ import annotations

from singitnow import halloffame, storage


def test_occupazione_e_pulizia_delle_tonalita(add_song):
    a = add_song("a")
    b = add_song("b")
    (a.dir / "video.mp4").write_bytes(b"v" * 1000)
    (a.dir / "vocals.m4a").write_bytes(b"x" * 300)
    (a.dir / "keys").mkdir()
    (a.dir / "keys" / "instrumental+2.m4a").write_bytes(b"k" * 200)
    (b.dir / "lyrics.json").write_bytes(b"{}")
    b.played_at = 123.0

    r = storage.report()
    first = r["songs"][0]
    assert first["id"] == "a" and first["sizes"] == {"video": 1000, "audio": 300, "keys": 200, "other": 0}
    assert r["keys"] == 200 and r["library"] == 1502
    assert first["never_played"] and not r["songs"][1]["never_played"]

    assert storage.clear_keys() == 200
    assert not (a.dir / "keys").exists()
    assert storage.report()["keys"] == 0


def test_brano_con_voti_non_e_mai_suonato(add_song):
    add_song("a")
    halloffame.add("Anna", "Verdi", "a", "Brano A", 80, 1.0, "Anna")
    assert not storage.report()["songs"][0]["never_played"]
