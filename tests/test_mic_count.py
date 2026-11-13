"""Numero di microfoni per cantare: lo leggono tutti i telefoni (per «Prendi il microfono Rosso / Blu»)."""

from fastapi.testclient import TestClient

from singitnow import app as appmod
from singitnow import mics


def test_un_telefono_qualsiasi_sa_quanti_microfoni_ci_sono(monkeypatch):
    monkeypatch.setattr(mics, "list_mics", lambda: [{"index": 0}, {"index": 1}])
    c = TestClient(appmod.app, client=("192.168.1.20", 5000))  # un telefono, non amministratore
    r = c.get("/api/mics/count")
    assert r.status_code == 200 and r.json() == {"count": 2}
    assert c.get("/api/mics").status_code in (401, 403)  # volumi e muto restano agli amministratori
