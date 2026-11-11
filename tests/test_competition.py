"""Classifica della modalità Competizione."""

from __future__ import annotations

from singitnow import competition as comp


def test_media_dei_voti_e_ordine():
    comp.add_score("Anna", "a", "A", 80)
    comp.add_score("Bruno", "b", "B", 90)
    comp.add_score("anna", "c", "C", 100)  # stessa persona, maiuscole diverse
    table = comp.standings()
    assert [(p["singer"], p["average"]) for p in table] == [("Anna", 90.0), ("Bruno", 90.0)]
    assert len(table[0]["songs"]) == 2


def test_a_pari_media_vince_chi_ha_cantato_prima():
    comp.add_score("Bruno", "b", "B", 70)
    comp.add_score("Anna", "a", "A", 70)
    assert [p["singer"] for p in comp.standings()] == ["Bruno", "Anna"]


def test_posizione_restituita():
    assert comp.add_score("Anna", "a", "A", 50) == 1
    assert comp.add_score("Bruno", "b", "B", 90) == 1
    assert comp.add_score("Carla", "c", "C", 70) == 2


def test_voti_che_non_contano():
    assert comp.add_score("  ", "a", "A", 90) is None  # brano senza cantante
    comp.set_enabled(False)
    assert comp.add_score("Anna", "a", "A", 90) is None
    assert comp.standings() == []


def test_accesa_a_playlist_in_corsa_esclude_il_brano_che_suona():
    comp.set_enabled(False)
    comp.set_enabled(True, playing_entry="e1")
    assert comp.add_score("Anna", "a", "A", 90, entry_id="e1") is None
    assert comp.add_score("Anna", "a", "A", 60, entry_id="e2") == 1


def test_la_classifica_resta_finche_non_finisce_la_serata():
    comp.on_playing(True)
    comp.add_score("Anna", "a", "A", 90)
    comp.on_playing(False)  # la musica si ferma (coda finita, Stop): la serata continua
    comp.on_playing(True)
    assert len(comp.standings()) == 1 and comp._active


def test_nuova_serata_svuota_la_classifica():
    comp.on_playing(True)
    comp.add_score("Anna", "a", "A", 90)
    comp.finish()  # serata conclusa da un amministratore
    assert comp.standings()  # resta consultabile a serata finita
    comp.on_playing(True)
    assert comp.standings() == []


def test_cambio_nome():
    comp.add_score("Marco", "a", "A", 90)
    comp.rename("marco", "Marco R.")
    assert comp.standings()[0]["singer"] == "Marco R."
