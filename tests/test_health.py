"""Brani con problemi (Settaggi dell'app sul PC) e reazioni dai telefoni."""

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
    assert health.report()["songs"] == []


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


def test_problema_ignorato_finche_il_brano_non_cambia(add_song):
    s = add_song("a")
    _complete(s)
    _lyrics(s, WORDS, source="whisper")
    _whisper(s, WORDS)
    assert codes(s) == ["lyrics_auto"]
    health.report()
    health.ignore("a", "lyrics_auto")
    assert health.report()["songs"] == []
    _lyrics(s, WORDS[:-1], source="whisper")  # il testo cambia: il problema torna
    import os
    os.utime(s.dir / "lyrics.json", (1, 1))
    assert [x["id"] for x in health.report()["songs"]] == ["a"]


def test_solo_dal_pc_e_reazioni(add_song):
    from singitnow import app as appmod
    from singitnow.playlist import Entry

    c = TestClient(appmod.app, client=("192.168.1.20", 5000))  # un telefono
    assert c.get("/api/admin/health").status_code == 403
    local = TestClient(appmod.app, client=("127.0.0.1", 5000))
    assert local.get("/api/admin/health").status_code == 200

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


def test_ripara_testi(add_song, monkeypatch):
    from singitnow import app as appmod
    from singitnow.pipeline import pipeline

    s = add_song("a")
    _complete(s)
    _lyrics(s, WORDS)
    _whisper(s, [(w, t + 30) for w, t in WORDS])
    done = []

    def fake(sid, text=None, fallback=None):
        _whisper(s, WORDS)
        data = json.loads((s.dir / "whisper.json").read_text(encoding="utf-8"))
        data["key"] = "small:1:full:it"
        (s.dir / "whisper.json").write_text(json.dumps(data), encoding="utf-8")
        done.append(sid)

    monkeypatch.setattr(pipeline, "_lyrics_only", fake)
    local = TestClient(appmod.app, client=("127.0.0.1", 5000))
    row = local.get("/api/admin/health").json()["songs"][0]
    assert row["issues"][0]["code"] == "lyrics_off" and not row["repaired"]
    local.post("/api/admin/health/repair", json={"song_ids": ["a"]})
    import time
    for _ in range(100):
        if not pipeline.repairing():
            break
        time.sleep(0.05)
    assert done == ["a"] and pipeline.repairing() == []
    assert local.get("/api/admin/health").json()["songs"] == []  # ora le parole si sentono al loro posto
