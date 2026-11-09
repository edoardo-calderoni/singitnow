"""Coda dei cantanti: prenotazioni, brani in preparazione, duetti, persistenza."""

from __future__ import annotations

import pytest

from singitnow import mode
from singitnow.library import DOWNLOADING
from singitnow.playlist import Playlist


@pytest.fixture
def pl():
    return Playlist()


def singers(pl: Playlist) -> list[str]:
    return [e.singer for e in pl._entries]


# ------------------------------------------------------------------ aggiunta e avvio
def test_dal_telefono_parte_subito_se_la_playlist_e_ferma(pl, add_song):
    add_song("a")
    pl.add("a", "Anna")
    assert pl.now_playing is not None and pl.now_playing.singer == "Anna"
    assert pl.now_playing.auto
    assert pl._entries == []


def test_dal_pc_non_parte_da_solo(pl, add_song):
    add_song("a")
    pl.add("a", "Anna", autostart=False, from_pc=True)
    assert pl.now_playing is None
    assert singers(pl) == ["Anna"]


def test_con_un_brano_in_corso_si_mette_in_coda(pl, add_song):
    add_song("a")
    add_song("b")
    pl.add("a", "Anna")
    pl.add("b", "Bruno")
    assert pl.now_playing.singer == "Anna"
    assert singers(pl) == ["Bruno"]


def test_nome_tagliato_a_40_caratteri_e_ripulito(pl, add_song):
    add_song("a")
    pl.add("a", "  " + "x" * 60 + "  ", autostart=False)
    assert pl._entries[0].singer == "x" * 40


def test_has_pending_ignora_maiuscole_e_spazi(pl, add_song):
    add_song("a")
    add_song("b", status=DOWNLOADING)
    pl.add("a", "Anna", autostart=False)
    pl.add("b", "Bruno", autostart=False)
    assert pl.has_pending(" anna ")
    assert pl.has_pending("BRUNO")  # anche se il brano è ancora in preparazione
    assert not pl.has_pending("Carla")
    assert not pl.has_pending("")


# ------------------------------------------------------------------ brani in preparazione
def test_brano_in_preparazione_non_compare_in_coda(pl, add_song):
    add_song("a", status=DOWNLOADING)
    pl.add("a", "Anna")
    assert pl._entries == [] and pl.now_playing is None
    assert pl._waiting == {"a": ["Anna"]}
    assert pl.wants_song("a")


def test_brano_pronto_parte_se_prenotato_dal_telefono(pl, add_song):
    song = add_song("a", status=DOWNLOADING)
    pl.add("a", "Anna")
    pl.song_ready(song)
    assert pl.now_playing is not None and pl.now_playing.singer == "Anna"
    assert pl._waiting == {}


def test_brano_pronto_aggiunto_dal_pc_non_parte(pl, add_song):
    song = add_song("a", status=DOWNLOADING)
    pl.add("a", "Anna", autostart=False, from_pc=True)
    pl.song_ready(song)
    assert pl.now_playing is None
    assert singers(pl) == ["Anna"]


def test_riproduzione_automatica_spenta(pl, add_song, monkeypatch):
    monkeypatch.setattr(mode, "autoplay", lambda: False)
    song = add_song("a", status=DOWNLOADING)
    pl.add("a", "Anna")
    pl.song_ready(song)
    assert pl.now_playing is None
    assert singers(pl) == ["Anna"]


def test_brano_pronto_riprende_il_suo_turno(pl, add_song, monkeypatch):
    """Chi ha prenotato prima un brano ancora da scaricare passa davanti a chi è arrivato dopo."""
    clock = iter(range(1000, 2000))  # un secondo in più a ogni lettura dell'orologio
    monkeypatch.setattr("singitnow.playlist.time.time", lambda: float(next(clock)))
    add_song("playing")
    slow = add_song("slow", status=DOWNLOADING)
    add_song("fast")
    pl.add("playing", "Zeno")  # parte subito, la coda resta vuota
    pl.add("slow", "Anna")
    pl.add("fast", "Bruno")
    assert singers(pl) == ["Bruno"]
    pl.song_ready(slow)
    assert singers(pl) == ["Anna", "Bruno"]


def test_annullare_una_prenotazione_in_preparazione(pl, add_song):
    add_song("a", status=DOWNLOADING)
    pl.add("a", "Anna", autostart=False)
    pl.remove_waiting("a", "Anna")
    assert pl._waiting == {} and pl._waiting_at == {} and pl._no_auto == {}
    assert not pl.wants_song("a")


# ------------------------------------------------------------------ ordine e riproduzione
def test_move_resta_nei_limiti(pl, add_song):
    for sid, name in (("a", "Anna"), ("b", "Bruno"), ("c", "Carla")):
        add_song(sid)
        pl.add(sid, name, autostart=False)
    first = pl._entries[0].id
    pl.move(first, -5)
    assert singers(pl) == ["Anna", "Bruno", "Carla"]
    pl.move(first, 99)
    assert singers(pl) == ["Bruno", "Carla", "Anna"]


def test_play_prende_il_primo_e_stop_ferma(pl, add_song):
    add_song("a")
    add_song("b")
    pl.add("a", "Anna", autostart=False)
    pl.add("b", "Bruno", autostart=False)
    assert pl.play().singer == "Anna"
    assert singers(pl) == ["Bruno"]
    pl.stop()
    assert pl.now_playing is None


def test_attesa_stimata(pl, add_song):
    add_song("a", duration=100)
    add_song("b", duration=200)
    add_song("c", duration=50)
    pl.now_remaining = lambda: 30.0
    pl.add("a", "Anna")  # in riproduzione
    pl.add("b", "Bruno")
    pl.add("c", "Carla")
    # Bruno: 30 s rimasti + pausa; Carla: in più il brano di Bruno + pausa
    assert pl._wait_before(0) == 30 + Playlist.GAP
    assert pl._wait_before(1) == 30 + Playlist.GAP + 200 + Playlist.GAP


# ------------------------------------------------------------------ richieste al DJ
def test_richieste_al_dj(pl, add_song):
    add_song("a")
    pl.request("a", "Anna")
    assert pl.has_request("ANNA")
    rid = pl._requests[0]["id"]
    assert pl.request_owner(rid) == "Anna"
    assert pl.take_request(rid)["song_id"] == "a"
    assert not pl.has_request("Anna")
    assert pl.take_request(rid) is None


# ------------------------------------------------------------------ duetti
@pytest.fixture
def queued(pl, add_song):
    add_song("a")
    pl.add("a", "Anna", autostart=False)
    return pl._entries[0]


def test_duetto_solo_sui_propri_brani(pl, queued):
    assert pl.propose_duet(queued.id, "Bruno", "Carla") == "Puoi proporre un duetto solo sui tuoi brani"
    assert pl.propose_duet(queued.id, "Anna", "anna") == "Scegli con chi cantare"
    assert pl.propose_duet("nessuno", "Anna", "Bruno") == "Il brano non è più in coda"


def test_duetto_accettato(pl, queued):
    assert pl.propose_duet(queued.id, "anna", "Bruno") == ""
    assert "aspetta la sua risposta" in pl.propose_duet(queued.id, "Anna", "Carla")
    duet = pl._duets[0]
    assert pl.answer_duet(duet["id"], "Carla", True) is None  # solo l'invitato risponde
    assert pl.answer_duet(duet["id"], "bruno", True) is not None
    assert queued.partner == "Bruno"
    assert "già questo brano in duetto" in pl.propose_duet(queued.id, "Anna", "Carla")


def test_duetto_rifiutato_e_ritirato(pl, queued):
    pl.propose_duet(queued.id, "Anna", "Bruno")
    pl.answer_duet(pl._duets[0]["id"], "Bruno", False)
    assert queued.partner == "" and pl._duets == []
    pl.propose_duet(queued.id, "Anna", "Bruno")
    did = pl._duets[0]["id"]
    assert not pl.cancel_duet(did, "Bruno")  # solo chi propone (o un amministratore)
    assert pl.cancel_duet(did, "Anna")


def test_sciogliere_il_duetto(pl, queued):
    pl.propose_duet(queued.id, "Anna", "Bruno")
    pl.answer_duet(pl._duets[0]["id"], "Bruno", True)
    assert pl.leave_duet(queued.id, "Carla") is None
    assert pl.leave_duet(queued.id, "Bruno") == ("Anna", "Bruno")
    assert queued.partner == ""


def test_proposta_decade_se_il_brano_esce_dalla_coda(pl, queued):
    pl.propose_duet(queued.id, "Anna", "Bruno")
    did = pl._duets[0]["id"]
    pl.remove(queued.id)
    assert pl.answer_duet(did, "Bruno", True) is None


# ------------------------------------------------------------------ nomi e persistenza
def test_cambio_nome_ovunque(pl, add_song):
    add_song("a")
    add_song("b", status=DOWNLOADING)
    add_song("c")
    pl.add("a", "Marco", autostart=False)
    pl.add("b", "marco", autostart=False)
    pl.request("c", "Marco")
    pl.propose_duet(pl._entries[0].id, "Marco", "Anna")
    pl.rename("Marco", "Marco R.")
    assert singers(pl) == ["Marco R."]
    assert pl._waiting["b"] == ["Marco R."]
    assert pl._requests[0]["singer"] == "Marco R."
    assert pl._duets[0]["from"] == "Marco R."


def test_la_coda_sopravvive_al_riavvio(pl, add_song):
    add_song("a")
    add_song("b", status=DOWNLOADING)
    add_song("c")
    pl.add("a", "Anna", autostart=False)
    pl.add("b", "Bruno", autostart=False)
    pl.request("c", "Carla")

    again = Playlist()
    again.load()
    assert singers(again) == ["Anna"]
    assert again._waiting == {"b": ["Bruno"]}
    assert again._requests[0]["singer"] == "Carla"


def test_al_riavvio_spariscono_i_brani_non_piu_in_libreria(pl, add_song):
    from singitnow.library import library

    add_song("a")
    add_song("b")
    pl.add("a", "Anna", autostart=False)
    pl.add("b", "Bruno", autostart=False)
    with library._lock:
        library._songs.pop("a")
    again = Playlist()
    again.load()
    assert singers(again) == ["Bruno"]


def test_forget_song(pl, add_song):
    add_song("a")
    pl.add("a", "Anna", autostart=False)
    pl.request("a", "Bruno")
    pl.forget_song("a")
    assert pl._entries == [] and pl._requests == []
    assert not pl.wants_song("a")


# ------------------------------------------------------------------ ordine della libreria
def test_il_brano_suonato_sale_in_cima_alla_libreria(pl, add_song):
    from singitnow.library import library

    old = add_song("vecchio")
    new = add_song("nuovo")
    old.created_at, new.created_at = 1000.0, 2000.0
    assert [s.id for s in library.all()] == ["nuovo", "vecchio"]  # mai suonati: per importazione
    pl.add("vecchio", "Anna")  # parte subito
    assert old.played_at > 0 and new.played_at == 0
    assert [s.id for s in library.all()] == ["vecchio", "nuovo"]


def test_la_riproduzione_si_segna_una_volta_per_avvio(pl, add_song):
    song = add_song("a")
    add_song("b")
    pl.add("a", "Anna")
    first = song.played_at
    pl.add("b", "Bruno")  # la coda cambia, ma «a» sta ancora suonando
    assert song.played_at == first
