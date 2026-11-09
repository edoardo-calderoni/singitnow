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


def test_nuova_sessione_svuota_la_classifica():
    comp.on_playing(True)
    comp.add_score("Anna", "a", "A", 90)
    comp._finish()  # la musica si è fermata del tutto
    assert comp.standings()  # resta consultabile a sessione finita
    comp.on_playing(True)
    assert comp.standings() == []


def test_musica_che_riparte_subito_e_la_stessa_sessione():
    comp.on_playing(True)
    comp.add_score("Anna", "a", "A", 90)
    comp.on_playing(False)
    comp.on_playing(True)  # prima di END_DELAY: il timer si annulla
    assert comp._end_timer is None
    assert len(comp.standings()) == 1


def test_cambio_nome():
    comp.add_score("Marco", "a", "A", 90)
    comp.rename("marco", "Marco R.")
    assert comp.standings()[0]["singer"] == "Marco R."


# ------------------------------------------------------------------ voto del pubblico
def test_voto_del_pubblico_pesa_sul_punteggio():
    comp.add_score("Anna", "a", "A", 80, entry_id="e1")
    assert comp.public()["vote"]["entry_id"] == "e1"
    assert comp.vote("e1", "Bruno", 5) == ""
    assert comp.vote("e1", "Carla", 3) == ""
    # 70% intonazione + 30% pubblico (media 4 stelle = 80)
    assert comp.standings()[0]["average"] == round(0.7 * 80 + 0.3 * 80)
    comp.vote("e1", "bruno", 1)  # Bruno cambia idea: media 2 stelle = 40
    song = comp.standings()[0]["songs"][0]
    assert song["score"] == round(0.7 * 80 + 0.3 * 40)
    assert song["pitch"] == 80 and song["audience"] == 2.0 and song["votes"] == 2


def test_chi_canta_non_vota_se_stesso():
    comp.add_score("Anna", "a", "A", 80, entry_id="e1", performers=["Anna", "Bruno"])  # duetto
    assert comp.vote("e1", "anna", 5) == "Non puoi votare la tua esibizione"
    assert comp.vote("e1", "Bruno", 5) == "Non puoi votare la tua esibizione"
    assert comp.vote("e1", "Carla", 5) == ""


def test_votazione_chiusa():
    comp.add_score("Anna", "a", "A", 80, entry_id="e1")
    assert comp.vote("e2", "Bruno", 5) == "La votazione di questa esibizione è chiusa"
    comp._vote["until"] = 0  # scaduta
    assert comp.vote("e1", "Bruno", 5) == "La votazione di questa esibizione è chiusa"
    assert comp.public()["vote"] is None
    assert comp.standings()[0]["average"] == 80


def test_senza_voti_conta_solo_l_intonazione():
    assert comp.combined(73, []) == 73
    assert comp.combined(50, [5, 5]) == round(0.7 * 50 + 0.3 * 100)
