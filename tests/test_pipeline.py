"""Coda di importazione: posizione e tempo stimato di ogni brano in attesa."""

from __future__ import annotations

from singitnow.library import QUEUED, SEPARATING
from singitnow.pipeline import Pipeline


def test_posizione_e_attesa_dei_brani_in_coda(add_song):
    pipe = Pipeline()
    current = add_song("ora", status=SEPARATING, duration=200)
    current.eta = 30.0
    pipe._current = "ora"
    songs = [add_song(sid, status=QUEUED, duration=200) for sid in ("a", "b", "c")]
    for k, s in enumerate(songs):
        s.created_at = 1000.0 + k
    pipe.refresh_queue()
    assert [s.queue_pos for s in songs] == [1, 2, 3]
    assert songs[0].step == "In coda: è il prossimo"
    assert songs[2].step == "In coda: 3° da preparare"
    one = pipe.expected_total(200)
    assert [s.eta for s in songs] == [round(30 + one, 1), round(30 + 2 * one, 1), round(30 + 3 * one, 1)]


def test_coda_senza_brani_in_elaborazione(add_song):
    pipe = Pipeline()
    s = add_song("a", status=QUEUED, duration=100)
    pipe.refresh_queue()
    assert s.queue_pos == 1 and s.eta == round(pipe.expected_total(100), 1)
