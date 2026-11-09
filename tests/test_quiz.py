"""Quiz musicale fra un brano e l'altro: avvio, domande, risposte, punti, annullamento."""

from __future__ import annotations

import json

import pytest

from singitnow import competition, mode, people, quiz


@pytest.fixture(autouse=True)
def setup(monkeypatch):
    monkeypatch.setattr(quiz, "fill_years", lambda: None)  # niente iTunes nei test
    with people._lock:
        people._people.clear()
        people._display.clear()
    quiz.cancel()
    quiz._recent.clear()
    quiz._tally.clear()
    mode.set_quiz(True)
    yield
    quiz.cancel()
    mode.set_quiz(False)
    with people._lock:
        people._people.clear()
        people._display.clear()


@pytest.fixture
def songs(add_song):
    out = []
    for i, (title, artist, year) in enumerate([
        ("Albachiara", "Vasco Rossi", 1979), ("Azzurro", "Adriano Celentano", 1968),
        ("Estate", "Negramaro", 2005), ("Sally", "Vasco Rossi", 1996),
    ]):
        s = add_song(f"s{i}", title=title)
        s.artist, s.year = artist, year
        (s.dir / "video.mp4").write_bytes(b"x")
        words = lambda *ws, t0: [{"t": w, "s": t0 + k, "e": t0 + k + 0.8} for k, w in enumerate(ws)]  # noqa: E731
        lines = [
            {"start": 20, "end": 24, "text": "una due tre cuore", "words": words("una", "due", "tre", "cuore", t0=20)},
            {"start": 30, "end": 34, "text": "una due tre amore", "words": words("una", "due", "tre", "amore", t0=30)},
            {"start": 40, "end": 44, "text": "una due tre sole", "words": words("una", "due", "tre", "sole", t0=40)},
        ]
        (s.dir / "lyrics.json").write_text(json.dumps({"lines": lines}), encoding="utf-8")
        out.append(s)
    return out


def test_senza_nessuno_collegato_o_spento_non_parte(songs):
    assert not quiz.start("e1")  # nessuno dal telefono
    people.join("Anna", "Rossi")
    mode.set_quiz(False)
    assert not quiz.start("e1")
    mode.set_quiz(True)
    competition.set_enabled(False)  # con la Competizione spenta niente quiz
    try:
        assert not quiz.start("e1")
    finally:
        competition.set_enabled(True)
    mode.set_mode(mode.JUKEBOX)
    try:
        assert not quiz.start("e1")
    finally:
        mode.set_mode(mode.KARAOKE)


def test_domande_ben_formate(songs):
    for _ in range(40):
        q = quiz._question(set())
        assert q and len(q["options"]) == 3 and len({o.casefold() for o in q["options"]}) == 3
        assert 0 <= q["correct"] < 3
        assert q["clip"]["end"] > q["clip"]["start"]
        if q["kind"] == "next_word":
            assert q["options"][q["correct"]] in {"cuore", "amore", "sole"}


def test_risposta_esatta_chiude_la_domanda_e_da_i_punti(songs):
    people.join("Anna", "Rossi")
    assert quiz.start("e1")
    assert quiz.public()["phase"] == "intro"
    assert "correct" not in quiz.public()  # la risposta giusta non si svela prima
    assert quiz.answer("Anna", 0) == "Non c'è una domanda aperta"
    quiz._advance(quiz._state["id"], "intro")
    assert quiz.public()["phase"] == "question"
    right = quiz._state["correct"]
    wrong = (right + 1) % 3
    assert quiz.answer("Marco", wrong) == ""
    assert quiz.answer("marco", right) == "Hai già risposto"
    assert quiz.public()["phase"] == "question"
    assert quiz.answer("Anna", right) == ""
    p = quiz.public()
    assert p["phase"] == "reveal" and p["winner"] == "Anna" and p["correct"] == right
    assert {a["name"] for a in p["answers"]} == {"Anna", "Marco"}
    assert p["points"] == 2  # +2 sulla media della Competizione


def test_punti_sulla_media_della_competizione_con_un_tetto():
    competition.set_enabled(True)
    competition.add_score("Anna", "s0", "Albachiara", 70)
    given = [competition.quiz_point("Anna") for _ in range(5)]
    assert given == [2, 2, 2, 0, 0]
    row = competition.standings()[0]
    assert row["average"] == 76 and row["quiz"] == 6


def test_cambio_di_brano_annulla_il_quiz(songs):
    people.join("Anna", "Rossi")
    assert quiz.start("e1")
    quiz.on_playlist("e1")  # stesso brano: continua
    assert quiz.public()["phase"] == "intro"
    quiz.on_playlist("e2")  # qualcuno ha avviato un altro brano
    assert quiz.public()["phase"] is None


def test_fasi_fino_alla_classifica(songs):
    people.join("Anna", "Rossi")
    assert quiz.start("e1")
    qid = quiz._state["id"]
    for phase in ("intro", "question", "reveal"):
        quiz._advance(qid, phase)
    p = quiz.public()
    assert p["phase"] == "ranking" and p["winner"] is None and "ranking" in p
    quiz._advance(qid, "ranking")
    assert quiz.public()["phase"] is None
