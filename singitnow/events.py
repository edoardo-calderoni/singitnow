"""Hub di eventi: distribuisce aggiornamenti in tempo reale a tutti i client WebSocket
(app desktop e telefoni). Può essere chiamato anche da thread worker."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import WebSocket


class EventHub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._names: dict[WebSocket, str] = {}  # telefoni collegati -> nome dell'utente
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.discard(ws)
        if self._names.pop(ws, None) is not None:
            self.publish("users", self.users())

    def set_name(self, ws: WebSocket, name: str) -> None:
        """Il telefono dice chi lo sta usando (per la scelta di chi canta dall'app sul PC)."""
        name = name.strip()[:40]
        if self._names.get(ws) == name:
            return
        if name:
            self._names[ws] = name
        else:
            self._names.pop(ws, None)
        self.publish("users", self.users())

    def users(self) -> list[str]:
        """Nomi degli utenti collegati in questo momento (senza doppioni, in ordine alfabetico)."""
        seen: dict[str, str] = {}
        for n in self._names.values():
            seen.setdefault(n.casefold(), n)
        return sorted(seen.values(), key=str.casefold)

    async def _broadcast(self, message: str) -> None:
        dead = []
        for ws in list(self._clients):
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._clients.discard(ws)
            self._names.pop(ws, None)

    def publish(self, event: str, data: Any) -> None:
        """Thread-safe: può essere chiamato dal thread di elaborazione."""
        if self._loop is None:
            return
        message = json.dumps({"event": event, "data": data})
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            self._loop.create_task(self._broadcast(message))
        else:
            asyncio.run_coroutine_threadsafe(self._broadcast(message), self._loop)


hub = EventHub()
