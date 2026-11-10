"""Controllo dei brani importati (inutilizzabili = rifiutati) e reazioni dai telefoni."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from singitnow import health
from singitnow.library import ERROR


def _lyrics(song, words, source="lrclib+whisper"):
    lines = [{"start": w[1], "end": w[1] + 1, "text": w[0], "words": [{"t": w[0], "s": w[1], "e": w[1] + 0.8}]} for w in words]
    (song.dir / "lyrics.json").write_text(json.dumps({"source": source, "lines": lines}), encoding="utf-8")


def _whisper(song, words):
    (song.dir / "whisper.json").write_text(json.dumps({"segments": [[[w, t, t + 0.5] for w, t in words]]}), encoding="utf-8")


def _complete(song):
    for f in ("video.mp4", "instrumental.m4a", "vocals.m4a", "beats.json"):
        (song.dir / f).write_bytes(b"x")
    notes = [[i, i + 0.5, 60] for i in range(30)]
    (song.dir / "pitch.json").write_text(json.dumps({"notes": notes}), encoding="utf-8")


WORDS = [(w, 10.0 + 2 * i) for i, w in enumerate(["cuore", "amore", "sole", "mare", "notte", "stelle", "vento", "strada"])]


def codes(song):
    return [i["code"] for i in health.check(song)]


def test_brano_a_posto(add_song):
    s = add_song("a")
    _complete(s)
    _lyrics(s, WORDS)
    _whisper(s, WORDS)
    assert codes(s) == []
    assert health.rejection(s) is None


def test_testo_fuori_tempo(add_song):
    s = add_song("a")
    _complete(s)
    _lyrics(s, WORDS)
    _whisper(s, [(w, t + 30) for w, t in WORDS])  # la voce canta le stesse parole 30 s dopo
    assert codes(s) == ["lyrics_off"]


def test_voce_poco_riconosciuta_non_si_puo_verificare(add_song):
    s = add_song("a")
    _complete(s)
    _lyrics(s, WORDS)
    _whisper(s, [("boh", 100.0)])
    assert codes(s) == ["lyrics_unverified"]


def test_mancanze_ed_errori(add_song):
    s = add_song("a")
    assert set(codes(s)) == {"files", "lyrics_missing", "pitch", "beats"}
    e = add_song("b", status=ERROR)
    e.error = "Video non disponibile"
    assert codes(e) == ["import"]


def test_reazioni(add_song):
    from singitnow import app as appmod
    from singitnow.playlist import Entry

    c = TestClient(appmod.app, client=("192.168.1.20", 5000))  # un telefono

    add_song("a")
    assert c.post("/api/reaction", json={"name": "Anna", "emoji": "🔥"}).json() == {"ok": False}  # niente in corso
    appmod.playlist.now_playing = Entry("e1", "a", "Marco")
    try:
        assert c.post("/api/reaction", json={"name": "Anna", "emoji": "💩"}).json() == {"ok": False}
        oks = [c.post("/api/reaction", json={"name": "Anna", "emoji": "🔥"}).json()["ok"] for _ in range(7)]
        assert oks == [True] * 5 + [False] * 2  # al massimo 5 ogni 3 secondi
    finally:
        appmod.playlist.now_playing = None


def test_lingua_dal_testo():
    from singitnow.lyrics import guess_language, parse_plain

    it = parse_plain("Voglio una vita che se ne frega\nche se ne frega di tutto sì\nnon è mai tardi per me\nio sono come te quando non ci sei\nma la vita è una cosa che non si ferma")
    en = parse_plain("I want it that way\nyou are my fire the one desire\nbelieve when I say\nyou are all that I need for the love")
    assert guess_language(it) == "it"
    assert guess_language(en) == "en"
    assert guess_language(parse_plain("la la la")) is None


def _importa(add_song, monkeypatch, good: bool):
    """Importazione con download e separazione già fatti: il testo è buono o fuori tempo."""
    from singitnow import playlist as plmod
    from singitnow.library import LYRICS, library
    from singitnow.pipeline import pipeline

    s = add_song("a", status=LYRICS)
    _complete(s)
    _whisper(s, WORDS)
    sent = []
    monkeypatch.setattr(plmod.hub, "publish", lambda ev, data: sent.append((ev, data)))
    monkeypatch.setattr(pipeline, "_build_lyrics", lambda sid, v, text=None, fallback=None: _lyrics(s, WORDS if good else [(w, t + 30) for w, t in WORDS]))
    monkeypatch.setattr(pipeline, "_build_pitch", lambda sid: None)
    monkeypatch.setattr(pipeline, "_build_beats", lambda sid: None)
    monkeypatch.setattr(pipeline, "_fetch_cover", lambda sid, *a: None)
    monkeypatch.setattr(pipeline, "_ready_callbacks", [])
    monkeypatch.setattr(pipeline, "_rejected_callbacks", [plmod.playlist.song_rejected])
    plmod.playlist._waiting["a"] = ["Anna", "Anna"]
    pipeline._process(library.get("a"))
    plmod.playlist._waiting.pop("a", None)
    return library.get("a"), sent


def test_importazione_rifiutata_se_il_testo_e_fuori_tempo(add_song, monkeypatch):
    song, sent = _importa(add_song, monkeypatch, good=False)
    assert song is None  # cancellato dalla libreria (e dal disco)
    ev = [d for e, d in sent if e == "import_rejected"]
    assert ev and ev[0]["singers"] == ["Anna"] and "a tempo" in ev[0]["reason"]
    assert ev[0]["song"]["id"] == "a"


def test_importazione_buona(add_song, monkeypatch):
    from singitnow.library import READY

    song, sent = _importa(add_song, monkeypatch, good=True)
    assert song is not None and song.status == READY
    assert not [e for e, _ in sent if e == "import_rejected"]
