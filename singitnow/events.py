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
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    async def _broadcast(self, message: str) -> None:
        dead = []
        for ws in list(self._clients):
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._clients.discard(ws)

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
