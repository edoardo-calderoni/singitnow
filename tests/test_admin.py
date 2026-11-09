"""Password amministratore e accessi."""

from __future__ import annotations

import json
import secrets

import pytest

from singitnow import admin


def set_password(pw: str) -> None:
    """Simula una password già scelta dai Settaggi (senza conoscere quella predefinita)."""
    salt = secrets.token_hex(16)
    admin._password_path().write_text(json.dumps({"salt": salt, "hash": admin._pbkdf2(pw, salt)}), encoding="utf-8")


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(admin, "_ITERATIONS", 1000)  # PBKDF2 veloce nei test
    monkeypatch.setattr(admin.time, "sleep", lambda s: None)


def test_password_salvata():
    set_password("segreta")
    assert admin.check_password("segreta")
    assert not admin.check_password("Segreta")


def test_cambio_password_e_uscita_degli_admin():
    set_password("vecchia")
    token = admin.login("vecchia", "Anna")
    assert token and admin.is_admin(token) and admin.name_of(token) == "Anna"
    admin.change_password("vecchia", "nuova1")
    assert admin.check_password("nuova1") and not admin.check_password("vecchia")
    assert not admin.is_admin(token)  # chi era amministratore rientra con la nuova


def test_cambio_password_rifiutato():
    set_password("vecchia")
    with pytest.raises(ValueError, match="attuale"):
        admin.change_password("sbagliata", "nuova1")
    with pytest.raises(ValueError, match="almeno"):
        admin.change_password("vecchia", "abc")


def test_variabile_d_ambiente_ha_la_precedenza(monkeypatch):
    set_password("dal-pc")
    monkeypatch.setenv("SINGITNOW_ADMIN_PASSWORD", "da-env")
    assert admin.check_password("da-env")
    assert not admin.check_password("dal-pc")
    with pytest.raises(ValueError, match="SINGITNOW_ADMIN_PASSWORD"):
        admin.change_password("da-env", "altra1")


def test_login_e_logout():
    set_password("pw12")
    assert admin.login("sbagliata", "Anna") is None
    token = admin.login("pw12", "Anna")
    admin.logout(token)
    assert not admin.is_admin(token)
    assert not admin.is_admin(None)
