"""Editor dei tempi del testo: API per salvare i tempi corretti a mano."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient


def test_api_tempi_solo_dal_pc(add_song):
    from singitnow import app as appmod

    song = add_song("a")
    lines = [{"start": 1.0, "end": 2.0, "text": "uno due", "words": [{"t": "uno", "s": 1.0, "e": 1.5}, {"t": "due", "s": 1.5, "e": 2.0}]}]
    (song.dir / "lyrics.json").write_text(json.dumps({"source": "x", "language": "it", "lines": lines}), encoding="utf-8")
    body = {"lines": [{"words": [{"s": 1.1, "e": 1.4}, {"s": 1.4, "e": 2.1}], "manual": True}]}

    phone = TestClient(appmod.app, client=("192.168.1.20", 5000))
    assert phone.put("/api/songs/a/timings", json=body).status_code in (401, 403)

    pc = TestClient(appmod.app, client=("127.0.0.1", 5000))
    r = pc.put("/api/songs/a/timings", json=body)
    assert r.status_code == 200 and r.json()["manual"] == 1
    saved = json.loads((song.dir / "lyrics.json").read_text(encoding="utf-8"))["lines"][0]
    assert saved["manual"] and saved["words"][0]["s"] == 1.1

    r = pc.put("/api/songs/a/timings", json={"lines": []})
    assert r.status_code == 400 and "riapri" in r.json()["detail"]
