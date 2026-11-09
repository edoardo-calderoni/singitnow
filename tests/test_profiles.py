"""Profili delle persone da una serata all'altra."""

from __future__ import annotations

import pytest

from singitnow import halloffame, people, profiles, stats


@pytest.fixture(autouse=True)
def clean():
    stats.reset()
    with people._lock:
        people._people.clear()
        people._display.clear()
    yield
    stats.reset()


def test_storico_e_record_personale():
    people.join("Anna", "Verdi")
    stats.started("e1", "a", "Brano A", "X", "Anna")
    stats.score("e1", "Anna", 70)
    stats.started("e2", "b", "Brano B", "Y", "Anna", partner="Bruno")
    stats.score("e2", "Anna", 91)
    stats.started("e3", "a", "Brano A", "X", "Anna")

    p = profiles.profile("anna", "VERDI")  # maiuscole e minuscole non contano
    assert p["performances"] == 3
    assert p["best"]["score"] == 91 and p["best"]["title"] == "Brano B"
    assert p["favorite"] == {"title": "Brano A", "count": 2}
    assert [r["song_id"] for r in p["recent"]] == ["a", "b", "a"]  # dal più recente
    assert p["recent"][1]["partner"] == "Bruno"


def test_il_duetto_finisce_nel_profilo_di_entrambi():
    people.join("Anna", "Verdi")
    people.join("Bruno", "Neri")
    stats.started("e1", "a", "Brano A", "X", "Anna", partner="Bruno")
    assert profiles.profile("Bruno", "Neri")["performances"] == 1
    assert profiles.profile("Bruno", "Neri")["recent"][0]["partner"] == "Anna"


def test_record_dai_voti_salvati_prima_dei_profili():
    halloffame.add("Carla", "Bianchi", "z", "Brano Z", 88, 1000.0, "Carla")
    p = profiles.profile("Carla", "Bianchi")
    assert p["best"]["score"] == 88 and p["performances"] == 0


def test_foto_legata_a_nome_e_cognome():
    profiles.save_photo("Marco", "Rossi", b"\xff\xd8foto")
    assert profiles.photo("marco", "rossi") == b"\xff\xd8foto"
    assert profiles.photo("Marco", "Bianchi") is None  # un omonimo non la prende
    profiles.remove_photo("Marco", "Rossi")
    assert profiles.photo("Marco", "Rossi") is None
