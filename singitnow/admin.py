"""Amministratori: chi conosce la password riceve un gettone che abilita i comandi riservati.

La password non è scritta in chiaro: qui c'è solo l'impronta SHA-256 di quella predefinita (il codice
è su GitHub). Si cambia dai «Settaggi» del PC o di un amministratore (impronta con sale in admin_password.json nella
cartella dati) oppure con la variabile d'ambiente SINGITNOW_ADMIN_PASSWORD, che ha la precedenza.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time

from fastapi import Header, HTTPException, Request

from . import config

_DEFAULT_SHA256 = "8ec996a4c6cf7aaf09f63a185bfc8d3babad976d0edae15b5ff8792c0ce1d944"
_lock = threading.Lock()


MIN_LENGTH = 4
_ITERATIONS = 200_000


def _expected_sha256() -> str:
    custom = os.environ.get("SINGITNOW_ADMIN_PASSWORD")
    return hashlib.sha256(custom.encode("utf-8")).hexdigest() if custom else _DEFAULT_SHA256


def _password_path():
    return config.DATA_DIR / "admin_password.json"


def _saved() -> dict | None:
    """Password scelta dal pannello «Settaggi» (sale + impronta PBKDF2), se c'è."""
    try:
        data = json.loads(_password_path().read_text(encoding="utf-8"))
        return data if data.get("salt") and data.get("hash") else None
    except (OSError, ValueError, AttributeError):
        return None


def _pbkdf2(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), _ITERATIONS).hex()


def check_password(password: str) -> bool:
    """Variabile d'ambiente > password scelta dal PC > password predefinita."""
    saved = _saved()
    if saved and not os.environ.get("SINGITNOW_ADMIN_PASSWORD"):
        return hmac.compare_digest(_pbkdf2(password, saved["salt"]), saved["hash"])
    digest = hashlib.sha256(password.encode("utf-8")).hexdigest()
    return hmac.compare_digest(digest, _expected_sha256())


def change_password(old: str, new: str) -> None:
    """Nuova password da amministratore. Gli amministratori già collegati devono rientrare.
    ValueError con il messaggio da mostrare se non si può."""
    if os.environ.get("SINGITNOW_ADMIN_PASSWORD"):
        raise ValueError("La password è impostata con SINGITNOW_ADMIN_PASSWORD: cambiala lì")
    if not check_password(old):
        time.sleep(0.6)
        raise ValueError("La password attuale non è corretta")
    if len(new) < MIN_LENGTH:
        raise ValueError(f"La nuova password deve avere almeno {MIN_LENGTH} caratteri")
    salt = secrets.token_hex(16)
    with _lock:
        _password_path().parent.mkdir(parents=True, exist_ok=True)
        _password_path().write_text(json.dumps({"salt": salt, "hash": _pbkdf2(new, salt)}), encoding="utf-8")
        _tokens_path().write_text("{}", encoding="utf-8")  # chi era amministratore rientra con la nuova


def _tokens_path():
    return config.DATA_DIR / "admin_tokens.json"


def _read() -> dict[str, dict]:
    try:
        return json.loads(_tokens_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def login(password: str, name: str) -> str | None:
    """Restituisce un nuovo gettone se la password è giusta, altrimenti None."""
    if not check_password(password):
        time.sleep(0.6)  # rallenta i tentativi a caso
        return None
    token = secrets.token_urlsafe(24)
    with _lock:
        tokens = _read()
        tokens[token] = {"name": name.strip()[:40], "since": int(time.time())}
        _tokens_path().write_text(json.dumps(tokens, ensure_ascii=False), encoding="utf-8")
    return token


def name_of(token: str | None) -> str:
    """Nome dell'amministratore a cui appartiene il gettone ("" se nessuno)."""
    return (_read().get(token or "") or {}).get("name", "") if token else ""


def is_admin(token: str | None) -> bool:
    return bool(token) and token in _read()


def logout(token: str | None) -> None:
    if not token:
        return
    with _lock:
        tokens = _read()
        if tokens.pop(token, None) is not None:
            _tokens_path().write_text(json.dumps(tokens, ensure_ascii=False), encoding="utf-8")


def require_admin(x_admin_token: str | None = Header(default=None)) -> None:
    """Dipendenza FastAPI per gli endpoint riservati agli amministratori (header X-Admin-Token)."""
    if not is_admin(x_admin_token):
        raise HTTPException(403, "Solo gli amministratori possono farlo")


_LOCAL = {"127.0.0.1", "::1", "localhost"}


def is_local(request: Request) -> bool:
    """True se la richiesta arriva dal PC stesso (l'app principale collegata alla TV)."""
    return (request.client.host if request.client else "") in _LOCAL


def can_control(request: Request, token: str | None) -> bool:
    """True per il PC stesso (la TV) o per un amministratore dal telefono."""
    host = request.client.host if request.client else ""
    return host in _LOCAL or is_admin(token)


def require_control(request: Request, x_admin_token: str | None = Header(default=None)) -> None:
    """Comandi del player: li può dare il PC stesso (la TV) oppure un amministratore dal telefono."""
    if not can_control(request, x_admin_token):
        raise HTTPException(403, "Solo gli amministratori possono controllare il brano")


def rename(old: str, new: str) -> None:
    """Un amministratore cambia nome (omonimo arrivato): il suo accesso resta valido."""
    with _lock:
        tokens = _read()
        changed = False
        for t in tokens.values():
            if isinstance(t, dict) and t.get("name", "").casefold() == old.casefold():
                t["name"] = new
                changed = True
        if changed:
            _tokens_path().write_text(json.dumps(tokens, ensure_ascii=False), encoding="utf-8")
