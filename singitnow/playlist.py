"""Playlist della serata: chi canta cosa, in che ordine."""

from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field

from . import competition, config, evening, keyfit, mode, people, quiz, stats
from .events import hub
from .library import READY, Song, library


@dataclass
class Entry:
    id: str
    song_id: str
    singer: str
    added_at: float = field(default_factory=time.time)
    auto: bool = False  # avviata automaticamente (playlist ferma): la TV passa a schermo intero
    partner: str = ""  # duetto: chi canta insieme a `singer` (ha accettato la proposta)
    key: int | None = None  # tonalità scelta da chi canta (None = non scelta: originale o automatica)


class Playlist:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._entries: list[Entry] = []
        self.now_playing: Entry | None = None
        # brano appena lasciato per passare al successivo (e quando): per il «Passa il microfono»
        self.previous: tuple[Entry, float] | None = None
        # Richieste di brani non ancora in libreria: song_id -> cantanti in attesa
        self._waiting: dict[str, list[str]] = {}
        # quando è stata fatta ogni prenotazione in preparazione (stesso ordine dei cantanti): quando il
        # brano è pronto riprende il suo turno davanti ai brani richiesti dopo e non ancora suonati
        self._waiting_at: dict[str, list[float]] = {}
        self._no_auto: dict[str, int] = {}  # brani in preparazione aggiunti dal PC: non partono da soli
        self._pc_waiting: dict[str, list[str]] = {}  # song_id -> cantanti scelti dal PC (per l'avviso «added»)
        # brani in preparazione accettati dal DJ: song_id -> [(chi l'ha chiesto, chi l'ha accettato)]
        self._approved_waiting: dict[str, list[tuple[str, str]]] = {}
        # modalità DJ: richieste degli utenti in attesa che il DJ le accetti
        self._requests: list[dict] = []  # {"id", "song_id", "singer", "at"}
        # proposte di duetto in attesa di risposta: {"id", "entry_id", "from", "to", "at"}
        self._duets: list[dict] = []
        self._file = config.DATA_DIR / "playlist.json"
        self._marked: str | None = None  # voce della playlist di cui è già segnata la riproduzione
        # secondi che mancano alla fine del brano in corso (lo imposta app.py dallo stato del player)
        self.now_remaining = lambda: 0.0

    # -------------------------------------------------------------- persistenza
    def load(self) -> None:
        try:
            raw = json.loads(self._file.read_text(encoding="utf-8"))
            # brani non più in libreria (es. scartati chiudendo l'app durante l'importazione): via dalla coda
            self._entries = [Entry(**e) for e in raw.get("entries", []) if library.get(e.get("song_id", ""))]
            playing = raw.get("now_playing")
            if playing and library.get(playing.get("song_id", "")):
                # l'app si è chiusa mentre suonava: il brano riparte da capo con «Avvia playlist»
                self._entries.insert(0, Entry(**(playing | {"auto": False})))
            self._waiting = {k: v for k, v in raw.get("waiting", {}).items() if library.get(k)}
            at = raw.get("waiting_at", {})
            self._waiting_at = {
                k: (at.get(k) if len(at.get(k) or []) == len(v) else [time.time()] * len(v))
                for k, v in self._waiting.items()
            }
            self._requests = [r for r in raw.get("requests", []) if library.get(r.get("song_id", ""))]
        except (FileNotFoundError, ValueError, TypeError):
            pass

    def _save(self) -> None:
        data = {
            # il brano che suonava: dopo un crash torna in cima alla coda (vedi load)
            "now_playing": asdict(self.now_playing) if self.now_playing else None,
            "entries": [asdict(e) for e in self._entries],
            "waiting": self._waiting,
            "waiting_at": self._waiting_at,
            "requests": self._requests,
        }
        self._file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def _autostart(self) -> Entry | None:
        """Se non sta suonando niente, la prima richiesta in coda parte subito (da chiamare col lock).
        Non dopo una serata conclusa: la serata nuova la fa partire un amministratore."""
        if self.now_playing is not None or not self._entries or evening.ended():
            return None
        entry = self._entries.pop(0)
        entry.auto = True
        self.now_playing = entry
        return entry

    def _changed(self) -> None:
        self._mark_played()
        self._save()
        hub.publish("playlist", self.snapshot())
        competition.on_playing(self.now_playing is not None)  # inizio/fine della sessione
        quiz.on_playlist(self.now_playing.id if self.now_playing else None)

    def _mark_played(self) -> None:
        """Il brano appena partito diventa il più recente della libreria (ordine «ultimi suonati»)."""
        e = self.now_playing
        if e is None or e.id == self._marked:
            return
        self._marked = e.id
        # dopo una serata conclusa ne comincia una nuova; in chiusura si aggiorna l'ultimo brano
        evening.on_started(e.id, self.upcoming())
        song = library.update(e.song_id, played_at=time.time())
        if song and not mode.is_jukebox():  # in Jukebox e DJ non si canta: niente esibizione
            stats.started(e.id, e.song_id, song.title, song.artist, e.singer, e.partner)

    # -------------------------------------------------------------- lettura
    def snapshot(self) -> dict:
        with self._lock:
            def pub(e: Entry | None):
                if e is None:
                    return None
                s = library.get(e.song_id)
                suggested, play = self._keys(e)
                return asdict(e) | {"song": s.to_public() if s else None, "suggested_key": suggested, "play_key": play}

            waiting = []
            for sid, singers in self._waiting.items():
                s = library.get(sid)
                times = self._waiting_at.get(sid, [])
                for i, singer in enumerate(singers):
                    waiting.append({
                        "song_id": sid,
                        "singer": singer,
                        "song": s.to_public() if s else None,
                        "requested_at": times[i] if i < len(times) else time.time(),
                    })
            waiting.sort(key=lambda w: w["requested_at"])
            queued = {e.id: e for e in self._entries}
            duets = []
            for d in self._duets:
                e = queued.get(d["entry_id"])
                s = library.get(e.song_id) if e else None
                if s:
                    duets.append(d | {"song": s.to_public()})
            requests = []
            for r in self._requests:
                s = library.get(r["song_id"])
                if s:
                    requests.append(r | {"song": s.to_public()})
            return {
                "now_playing": pub(self.now_playing),
                "entries": [pub(e) for e in self._entries if library.get(e.song_id)],
                "waiting": waiting,
                "requests": requests,  # modalità DJ: in attesa che il DJ le accetti
                "duets": duets,  # proposte di duetto in attesa di risposta
            }

    # -------------------------------------------------------------- modifica
    def has_pending(self, singer: str) -> bool:
        """True se `singer` ha già un brano in coda (pronto o ancora in preparazione)."""
        k = singer.strip().casefold()
        if not k:
            return False
        with self._lock:
            return any(e.singer.strip().casefold() == k for e in self._entries) or any(
                n.strip().casefold() == k for names in self._waiting.values() for n in names
            )

    def has_unplayed(self, song_id: str) -> bool:
        """True se il brano è già in playlist e non è ancora stato riprodotto: in coda o ancora in
        preparazione (quello che sta suonando non conta: finito, si può richiedere)."""
        with self._lock:
            return any(e.song_id == song_id for e in self._entries) or bool(self._waiting.get(song_id))

    def add(
        self, song_id: str, singer: str, autostart: bool = True, from_pc: bool = False, approved_by: str | None = None
    ) -> None:
        """Mette il brano in coda. Con autostart (prenotazioni dal telefono) parte subito se la
        playlist è ferma; dall'app principale invece si aspetta «Avvia playlist».
        from_pc: aggiunto dall'app sul PC (la TV non mostra l'avviso, i telefoni sì).

        Due avvisi, "request" (TV: «Nuovo brano aggiunto») e "added" (telefoni), solo quando il brano
        entra davvero in playlist: subito se è pronto, altrimenti a fine preparazione (vedi
        song_ready). Mentre si prepara il brano non compare in playlist.
        approved_by: richiesta accettata dal DJ (nome): l'avviso "added" va solo a chi l'ha chiesta."""
        singer = singer.strip()[:40]  # può restare vuoto (brano aggiunto dal PC senza nome)
        with self._lock:
            song = library.get(song_id)
            if song and song.status == READY:
                self._entries.append(Entry(uuid.uuid4().hex[:10], song_id, singer))
                started = autostart and self._autostart()
                position = -1 if started else len(self._entries)  # -1 = parte subito
                # playlist ferma e brano che non parte da solo: si aspetta «Avvia playlist» (niente stima)
                wait = 0.0 if started else (self._wait_before(len(self._entries) - 1) if self.now_playing else None)
                added = [self._added_event(song, singer, position, wait, from_pc, approved_by)]
            else:
                added = []  # nessun avviso finché il brano non è pronto (vedi song_ready)
                self._waiting.setdefault(song_id, []).append(singer)
                self._waiting_at.setdefault(song_id, []).append(time.time())
                if from_pc:
                    self._pc_waiting.setdefault(song_id, []).append(singer)
                if approved_by is not None:
                    self._approved_waiting.setdefault(song_id, []).append((singer, approved_by))
                if not autostart:
                    self._no_auto[song_id] = self._no_auto.get(song_id, 0) + 1
                position = 0  # in preparazione
                wait = None
            self._changed()
        for ev in added:
            # Avviso sulla TV: "Nuovo brano aggiunto in coda da <nome>" + fra quanto verrà riprodotto
            hub.publish("request", self._request_event(ev))
            hub.publish("added", ev)

    @staticmethod
    def _request_event(added: dict) -> dict:
        """Avviso per la TV a partire da quello per i telefoni (stessi dati, senza approved_by)."""
        return {k: added[k] for k in ("singer", "position", "wait", "song", "from_pc")}

    @staticmethod
    def _added_event(
        song: Song, singer: str, position: int, wait: float | None, from_pc: bool, approved_by: str | None = None
    ) -> dict:
        """Avviso per i telefoni: il brano è in coda (position -1 = parte subito, wait in secondi).
        approved_by: richiesta accettata dal DJ (l'avviso è solo per chi l'ha chiesta)."""
        ev = {"singer": singer, "position": position, "wait": wait, "song": song.to_public(), "from_pc": from_pc}
        if approved_by is not None:
            ev["approved_by"] = approved_by
        return ev

    # -------------------------------------------------------------- richieste al DJ
    def request(self, song_id: str, singer: str) -> None:
        """Modalità DJ: il brano chiesto da un utente aspetta che il DJ lo accetti."""
        with self._lock:
            self._requests.append(
                {"id": uuid.uuid4().hex[:10], "song_id": song_id, "singer": singer.strip()[:40], "at": int(time.time())}
            )
            self._changed()

    def has_request(self, singer: str) -> bool:
        """True se `singer` ha già una richiesta in attesa del DJ."""
        k = singer.strip().casefold()
        with self._lock:
            return bool(k) and any(r["singer"].strip().casefold() == k for r in self._requests)

    def take_request(self, request_id: str) -> dict | None:
        """Toglie la richiesta dall'elenco (accettata o rifiutata) e la restituisce."""
        with self._lock:
            r = next((r for r in self._requests if r["id"] == request_id), None)
            if r:
                self._requests.remove(r)
                self._changed()
            return r

    def request_owner(self, request_id: str) -> str | None:
        with self._lock:
            return next((r["singer"] for r in self._requests if r["id"] == request_id), None)

    # -------------------------------------------------------------- tonalità di chi canta
    def _keys(self, e: Entry) -> tuple[int | None, int]:
        """(tonalità consigliata a chi canta, tonalità in cui partirà il brano).
        Solo in Karaoke e da soli: in duetto le voci sono due."""
        if mode.is_jukebox() or e.partner or not e.singer.strip():
            return None, 0
        first, last = people.full_of(e.singer) or (e.singer, "")
        suggested = keyfit.suggest(e.song_id, first, last)
        play = e.key if e.key is not None else (suggested or 0) if mode.auto_key() else 0
        if play:
            keyfit.prepare(e.song_id, play)  # così il brano parte subito nella tonalità giusta
        return suggested, play

    def set_key(self, entry_id: str, name: str, key: int | None) -> tuple[str, int | None]:
        """Chi canta sceglie la tonalità del suo brano (key=None: quella consigliata).
        Restituisce (errore o "", tonalità se il brano sta già suonando)."""
        name = name.strip().casefold()
        with self._lock:
            e = self._entry(entry_id) or (self.now_playing if self.now_playing and self.now_playing.id == entry_id else None)
            if e is None:
                return "Il brano non è più in coda", None
            if e.singer.strip().casefold() != name:
                return "Puoi cambiare la tonalità solo dei tuoi brani", None
            suggested, _ = self._keys(e)
            if key is None:
                if not suggested:
                    return "Non conosco ancora abbastanza bene la tua voce", None
                key = suggested
            e.key = max(-keyfit.audio.KEY_RANGE, min(keyfit.audio.KEY_RANGE, int(key)))
            self._changed()
            return "", e.key if e is self.now_playing else None

    # -------------------------------------------------------------- duetti
    def _entry(self, entry_id: str) -> Entry | None:
        return next((e for e in self._entries if e.id == entry_id), None)

    def _live_duets(self) -> list[dict]:
        """Proposte ancora valide: il brano è ancora in coda (da chiamare col lock)."""
        ids = {e.id for e in self._entries}
        self._duets = [d for d in self._duets if d["entry_id"] in ids]
        return self._duets

    def propose_duet(self, entry_id: str, by: str, to: str) -> str:
        """`by` (chi ha prenotato il brano) propone a `to` di cantarlo in duetto.
        Restituisce "" se va bene, altrimenti il motivo del rifiuto."""
        by, to = by.strip()[:40], to.strip()[:40]
        with self._lock:
            e = self._entry(entry_id)
            if e is None:
                return "Il brano non è più in coda"
            if e.singer.casefold() != by.casefold():
                return "Puoi proporre un duetto solo sui tuoi brani"
            if not to or to.casefold() == by.casefold():
                return "Scegli con chi cantare"
            if e.partner:
                return f"Canti già questo brano in duetto con {e.partner}"
            pending = next((d for d in self._live_duets() if d["entry_id"] == entry_id), None)
            if pending:
                return f"Hai già proposto il duetto a {pending['to']}: aspetta la sua risposta"
            self._duets.append(
                {"id": uuid.uuid4().hex[:10], "entry_id": entry_id, "from": e.singer, "to": to, "at": int(time.time())}
            )
            self._changed()
            return ""

    def answer_duet(self, duet_id: str, by: str, accept: bool) -> dict | None:
        """Chi ha ricevuto la proposta accetta o rifiuta. Restituisce la proposta (None se non c'è più)."""
        with self._lock:
            d = next((d for d in self._live_duets() if d["id"] == duet_id), None)
            if d is None or d["to"].casefold() != by.strip().casefold():
                return None
            self._duets.remove(d)
            e = self._entry(d["entry_id"])
            if accept and e is not None:
                e.partner = d["to"]
            self._changed()
            s = library.get(e.song_id) if e else None
            return d | {"song": s.to_public() if s else None, "entry_id": d["entry_id"]}

    def cancel_duet(self, duet_id: str, by: str, force: bool = False) -> bool:
        """Chi ha fatto la proposta la ritira (o un amministratore)."""
        with self._lock:
            d = next((d for d in self._live_duets() if d["id"] == duet_id), None)
            if d is None or (not force and d["from"].casefold() != by.strip().casefold()):
                return False
            self._duets.remove(d)
            self._changed()
            return True

    def leave_duet(self, entry_id: str, by: str, force: bool = False) -> tuple[str, str] | None:
        """Il duetto si scioglie: lo annulla chi ha prenotato o chi si è unito (o un amministratore).
        Restituisce (cantante, partner) se c'era un duetto."""
        k = by.strip().casefold()
        with self._lock:
            e = self._entry(entry_id)
            if e is None or not e.partner:
                return None
            if not force and k not in (e.singer.casefold(), e.partner.casefold()):
                return None
            pair = (e.singer, e.partner)
            e.partner = ""
            self._changed()
            return pair

    GAP = 6.0  # secondi tra un brano e l'altro (annuncio, applausi), come nel calcolo dei telefoni

    def _wait_before(self, index: int) -> float:
        """Secondi stimati prima che parta la voce in coda numero `index` (da chiamare col lock)."""
        t = (max(0.0, float(self.now_remaining())) + self.GAP) if self.now_playing else 0.0
        for e in self._entries[:index]:
            s = library.get(e.song_id)
            t += (s.duration if s else 0) + self.GAP
        return round(t)

    def song_ready(self, song: Song | None) -> None:
        if song is None:
            return
        with self._lock:
            singers = self._waiting.pop(song.id, [])
            times = self._waiting_at.pop(song.id, [])
            from_pc = self._no_auto.pop(song.id, 0)
            pc_singers = self._pc_waiting.pop(song.id, [])
            approved = self._approved_waiting.pop(song.id, [])
            new = []
            for i, singer in enumerate(singers):
                t = times[i] if i < len(times) else time.time()
                e = Entry(uuid.uuid4().hex[:10], song.id, singer, added_at=t)
                # riprende il suo turno: davanti ai brani richiesti dopo di lui e non ancora suonati
                # (se l'importazione è durata più della coda, quelli sono già passati e non si aspetta)
                idx = next((k for k, x in enumerate(self._entries) if x.added_at > t), len(self._entries))
                self._entries.insert(idx, e)
                new.append(e)
            # almeno una prenotazione dal telefono (e «Riproduzione automatica» ancora accesa)
            if len(singers) > from_pc and mode.autoplay():
                self._autostart()
            # avvisi per i telefoni: ora il brano è davvero in coda (posizione e attesa da adesso)
            added = []
            for e in new:
                if self.now_playing is e:
                    position, wait = -1, 0.0
                elif e in self._entries:
                    idx = self._entries.index(e)
                    position = idx + 1
                    wait = self._wait_before(idx) if self.now_playing else None
                else:
                    continue
                pc = e.singer in pc_singers
                if pc:
                    pc_singers.remove(e.singer)
                by = next((a for a in approved if a[0] == e.singer), None)
                if by:
                    approved.remove(by)
                added.append(self._added_event(song, e.singer, position, wait, pc, by[1] if by else None))
        if singers:
            self._changed()
            for ev in added:
                hub.publish("request", self._request_event(ev))
                hub.publish("added", ev)
        else:
            hub.publish("playlist", self.snapshot())

    def singer_of(self, entry_id: str) -> str | None:
        """Chi ha prenotato la voce in coda o quella in riproduzione (None se non c'è)."""
        with self._lock:
            if self.now_playing and self.now_playing.id == entry_id:
                return self.now_playing.singer
            return next((e.singer for e in self._entries if e.id == entry_id), None)

    def is_playing(self, entry_id: str) -> bool:
        with self._lock:
            return bool(self.now_playing and self.now_playing.id == entry_id)

    def is_playing_song(self, song_id: str) -> bool:
        with self._lock:
            return bool(self.now_playing and self.now_playing.song_id == song_id)

    def remove(self, entry_id: str) -> None:
        with self._lock:
            self._entries = [e for e in self._entries if e.id != entry_id]
            self._changed()

    def move(self, entry_id: str, delta: int) -> None:
        with self._lock:
            idx = next((i for i, e in enumerate(self._entries) if e.id == entry_id), None)
            if idx is None:
                return
            new = max(0, min(len(self._entries) - 1, idx + delta))
            self._entries.insert(new, self._entries.pop(idx))
            self._changed()

    def upcoming(self) -> list[str]:
        """Voci in coda pronte da suonare, in ordine."""
        return [e.id for e in self._entries if library.get(e.song_id)]

    def play(self, entry_id: str | None = None) -> Entry | None:
        """Avvia la voce indicata (o la prima in coda) togliendola dalla coda. Finito l'ultimo brano
        della serata in chiusura non si va avanti: la musica si ferma e la serata si conclude."""
        with self._lock:
            if entry_id is None and self.now_playing and evening.is_last(self.now_playing.id):
                self.now_playing = None
                self._changed()
                ended = True
            else:
                ended = False
        if ended:
            evening.finish()
            return None
        with self._lock:
            if entry_id:
                entry = next((e for e in self._entries if e.id == entry_id), None)
            else:
                entry = next((e for e in self._entries if library.get(e.song_id)), None)
            if entry:
                self._entries.remove(entry)
            if self.now_playing is not None and entry is not None:
                self.previous = (self.now_playing, time.time())
            self.now_playing = entry
            self._changed()
            return entry

    def play_song(self, song_id: str, singer: str = "") -> Entry:
        with self._lock:
            self.now_playing = Entry(uuid.uuid4().hex[:10], song_id, singer)
            self._changed()
            return self.now_playing

    def stop(self) -> None:
        with self._lock:
            last = self.now_playing is not None and evening.is_last(self.now_playing.id)
            self.now_playing = None
            self._changed()
        if last:  # fermato l'ultimo brano della serata: si conclude lo stesso
            evening.finish()

    def remove_waiting(self, song_id: str, singer: str) -> None:
        """Annulla la prenotazione di un brano ancora in preparazione."""
        with self._lock:
            singers = self._waiting.get(song_id, [])
            if singer in singers:
                times = self._waiting_at.get(song_id, [])
                i = singers.index(singer)
                if i < len(times):
                    times.pop(i)
                singers.remove(singer)  # una sola prenotazione per volta
                if not singers:
                    self._waiting.pop(song_id, None)
                    self._waiting_at.pop(song_id, None)
                    self._no_auto.pop(song_id, None)  # nessuna prenotazione rimasta per il brano
                if singer in self._pc_waiting.get(song_id, []):
                    self._pc_waiting[song_id].remove(singer)
                approved = self._approved_waiting.get(song_id, [])
                by = next((a for a in approved if a[0] == singer), None)
                if by:
                    approved.remove(by)
                self._changed()

    def rename(self, old: str, new: str) -> None:
        """Qualcuno cambia nome (arrivato un omonimo: «Marco» -> «Marco R.»): ovunque nella coda."""
        o = old.casefold()
        same = lambda n: bool(n) and n.casefold() == o  # noqa: E731
        with self._lock:
            for e in [*self._entries, *([self.now_playing] if self.now_playing else [])]:
                if same(e.singer):
                    e.singer = new
                if same(e.partner):
                    e.partner = new
            for d in (self._waiting, self._pc_waiting):
                for names in d.values():
                    names[:] = [new if same(n) else n for n in names]
            for pairs in self._approved_waiting.values():
                pairs[:] = [(new if same(a) else a, new if same(b) else b) for a, b in pairs]
            for r in self._requests:
                if same(r.get("singer", "")):
                    r["singer"] = new
            for d in self._duets:
                for k in ("from", "to"):
                    if same(d.get(k, "")):
                        d[k] = new
            self._changed()

    def wants_song(self, song_id: str) -> bool:
        """Qualcuno aspetta ancora quel brano (in coda, in preparazione o come richiesta al DJ)?"""
        with self._lock:
            return (
                bool(self._waiting.get(song_id))
                or any(e.song_id == song_id for e in self._entries)
                or any(r["song_id"] == song_id for r in self._requests)
            )

    def song_rejected(self, song: Song | None, reason: str) -> None:
        """Brano importato ma inutilizzabile: chi aspettava di cantarlo (e il PC) viene avvisato."""
        if song is None:
            return
        with self._lock:
            singers = list(dict.fromkeys(self._waiting.get(song.id, [])))
        self.forget_song(song.id)
        hub.publish("import_rejected", {"song": song.to_public(), "reason": reason, "singers": singers})

    def forget_song(self, song_id: str) -> None:
        with self._lock:
            self._entries = [e for e in self._entries if e.song_id != song_id]
            self._waiting.pop(song_id, None)
            self._waiting_at.pop(song_id, None)
            self._pc_waiting.pop(song_id, None)
            self._approved_waiting.pop(song_id, None)
            self._requests = [r for r in self._requests if r["song_id"] != song_id]
            self._changed()


playlist = Playlist()
