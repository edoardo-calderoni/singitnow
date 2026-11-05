"""Amministratori: chi conosce la password riceve un gettone che abilita i comandi riservati.

La password non è scritta in chiaro: qui c'è solo la sua impronta SHA-256 (il codice è su GitHub).
Si può cambiare con la variabile d'ambiente SINGITNOW_ADMIN_PASSWORD.
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


def _expected_sha256() -> str:
    custom = os.environ.get("SINGITNOW_ADMIN_PASSWORD")
    return hashlib.sha256(custom.encode("utf-8")).hexdigest() if custom else _DEFAULT_SHA256


def _tokens_path():
    return config.DATA_DIR / "admin_tokens.json"


def _read() -> dict[str, dict]:
    try:
        return json.loads(_tokens_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def login(password: str, name: str) -> str | None:
    """Restituisce un nuovo gettone se la password è giusta, altrimenti None."""
    digest = hashlib.sha256(password.encode("utf-8")).hexdigest()
    if not hmac.compare_digest(digest, _expected_sha256()):
        time.sleep(0.6)  # rallenta i tentativi a caso
        return None
    token = secrets.token_urlsafe(24)
    with _lock:
        tokens = _read()
        tokens[token] = {"name": name.strip()[:40], "since": int(time.time())}
        _tokens_path().write_text(json.dumps(tokens, ensure_ascii=False), encoding="utf-8")
    return token


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


def can_control(request: Request, token: str | None) -> bool:
    """True per il PC stesso (la TV) o per un amministratore dal telefono."""
    host = request.client.host if request.client else ""
    return host in _LOCAL or is_admin(token)


def require_control(request: Request, x_admin_token: str | None = Header(default=None)) -> None:
    """Comandi del player: li può dare il PC stesso (la TV) oppure un amministratore dal telefono."""
    if not can_control(request, x_admin_token):
        raise HTTPException(403, "Solo gli amministratori possono controllare il brano")
