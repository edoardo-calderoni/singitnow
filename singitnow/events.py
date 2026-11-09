"""Hub di eventi: distribuisce aggiornamenti in tempo reale a tutti i client WebSocket
(app desktop e telefoni). Può essere chiamato anche da thread worker."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from fastapi import WebSocket


class EventHub:
    REJOIN_QUIET = 600.0  # s: chi si ricollega entro 10 minuti non viene annunciato di nuovo
    # s: chi è entrato nella festa resta tra gli utenti anche col telefono in standby (schermo spento:
    # il telefono chiude la connessione) finché non si ricollega o non esce dal profilo
    PARTY_GRACE = 3 * 3600.0

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._names: dict[WebSocket, str] = {}  # telefoni collegati -> nome dell'utente
        self._last_seen: dict[str, float] = {}  # nome (minuscolo) -> ultima volta che era collegato
        self._known: dict[str, str] = {}  # nome (minuscolo) -> come si scrive (per chi è in standby)
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.discard(ws)
        name = self._names.pop(ws, None)
        if name is not None:
            self._last_seen[name.casefold()] = time.monotonic()
            self.publish("users", self.users())

    def set_name(self, ws: WebSocket, name: str) -> None:
        """Il telefono dice chi lo sta usando (per la scelta di chi canta dall'app sul PC)."""
        name = name.strip()[:40]
        if self._names.get(ws) == name:
            return
        before = {n.casefold() for n in self._names.values()}
        old = self._names.get(ws)
        if old:
            self._last_seen[old.casefold()] = time.monotonic()
        if name:
            self._names[ws] = name
            self._known[name.casefold()] = name
        else:
            self._names.pop(ws, None)
            if old:
                # uscito dalla festa («Esci» nel profilo): via subito dagli utenti
                self._last_seen.pop(old.casefold(), None)
                self._known.pop(old.casefold(), None)
        self.publish("users", self.users())
        # avviso «… si è unito alla festa» sulla TV: non per chi si ricollega dopo pochi minuti
        # (pagina ricaricata, Wi-Fi perso un attimo) né per chi è già collegato da un altro telefono
        k = name.casefold()
        if name and k not in before and time.monotonic() - self._last_seen.get(k, -1e9) > self.REJOIN_QUIET:
            self.publish("user_joined", {"name": name})
        if name:
            self._last_seen[k] = time.monotonic()

    def rename(self, old: str, new: str) -> None:
        """Un utente collegato cambia nome (omonimo arrivato)."""
        o = old.casefold()
        for ws, n in list(self._names.items()):
            if n.casefold() == o:
                self._names[ws] = new
        if o in self._last_seen:
            self._last_seen[new.casefold()] = self._last_seen.pop(o)
        if o in self._known:
            self._known.pop(o)
            self._known[new.casefold()] = new
        self.publish("users", self.users())

    def users(self) -> list[str]:
        """Utenti della festa (senza doppioni, in ordine alfabetico): quelli collegati e quelli col
        telefono in standby da meno di PARTY_GRACE secondi."""
        seen: dict[str, str] = {}
        for n in self._names.values():
            seen.setdefault(n.casefold(), n)
        now = time.monotonic()
        for k, t in self._last_seen.items():
            if k not in seen and k in self._known and now - t < self.PARTY_GRACE:
                seen[k] = self._known[k]
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
