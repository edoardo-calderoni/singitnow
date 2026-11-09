"""Voce dei microfoni gestita da SingITnow (con autotune), invece che da Windows.

Con la scelta «SingITnow» il server avvia il motore audio (voice_engine, processo separato a bassa
latenza) che prende i microfoni, corregge l'intonazione verso la melodia del brano in corso e manda
la voce alle casse. In Windows va disattivato «Ascolta questo dispositivo» sui microfoni (altrimenti
la voce si sente due volte): l'app lo controlla e lo segnala.
"""

from __future__ import annotations

import json
import logging
import multiprocessing as mp
import threading
import time

from . import config, mics
from .events import hub

log = logging.getLogger(__name__)

# amplificazione della voce dei microfoni: sempre al massimo (4 = +12 dB, con limitatore), perché la
# musica della TV non copra chi canta
BOOST = 4.0
_DEFAULTS = {"engine": False, "autotune": False, "strength": 0.6, "boost": BOOST}


class Voice:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._proc = None
        self._cmd = None
        self._status = None
        self._mic_names: list[str] = []
        self._out_name = ""  # uscita con cui è partito il motore
        self._state = {"running": False, "latency_ms": 0, "mics": 0, "error": "", "correction_cents": 0, "singing": False}
        self._song_id = ""
        self._last_public: dict | None = None
        self._watcher: threading.Thread | None = None
        self._listening: list[str] = []
        self._playing_song = ""  # brano in corso (per spegnere l'autotune quando finisce)
        self._failed_at = 0.0
        self._failed_names: list[str] = []

    # ------------------------------------------------------------ impostazioni
    @staticmethod
    def _path():
        return config.DATA_DIR / "settings.json"

    def settings(self) -> dict:
        try:
            data = json.loads(self._path().read_text(encoding="utf-8")).get("voice") or {}
        except (OSError, ValueError):
            data = {}
        out = dict(_DEFAULTS)
        out.update({k: data[k] for k in _DEFAULTS if k in data})
        out["strength"] = max(0.0, min(1.0, float(out["strength"])))
        out["boost"] = BOOST  # fissa: non si regola più
        from . import competition

        if competition.enabled():
            out["autotune"] = False  # in gara si canta con la propria voce: niente autotune
        return out

    def update(self, **changes) -> dict:
        with self._lock:
            try:
                data = json.loads(self._path().read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = {}
            cur = self.settings()
            cur.update({k: v for k, v in changes.items() if k in _DEFAULTS and v is not None})
            if cur["autotune"]:
                cur["engine"] = True  # l'autotune richiede che la voce passi da SingITnow
            data["voice"] = cur
            self._path().write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        self.apply()
        return self.public()

    def public(self) -> dict:
        s = self.settings()
        state = dict(self._state)
        if state["running"] and s["autotune"]:
            state["latency_ms"] += 10  # elaborazione dell'autotune
        return s | state | {"listening": self._listening if s["engine"] else []}

    def _publish(self) -> None:
        p = self.public()
        if p != self._last_public:
            self._last_public = p
            hub.publish("voice", p)

    # ------------------------------------------------------------ motore audio
    def apply(self) -> None:
        """Avvia, ferma o aggiorna il motore secondo le impostazioni (e i microfoni collegati)."""
        with self._lock:
            s = self.settings()
            if not s["engine"]:
                self._stop()
            else:
                names = [m["name"] for m in mics.list_mics()]
                # la voce va sulle casse del PC, non sulla TV: la TV la ritarderebbe troppo
                output = mics.speakers()
                if output is None:  # lettura non riuscita: non si riavvia il motore per questo
                    output = self._out_name
                if not names:
                    self._stop()
                    self._state = {"running": False, "latency_ms": 0, "mics": 0, "error": "Nessun microfono collegato", "correction_cents": 0, "singing": False}
                elif names != self._mic_names or output != self._out_name or not self._alive():
                    # dopo un errore (microfono occupato…) si riprova solo dopo un po' o con altri microfoni
                    failed = self._state.get("error") and names == self._failed_names and output == self._out_name
                    if not failed or time.monotonic() - self._failed_at > 30:
                        error = self._state.get("error", "")
                        self._stop()
                        self._start(names, output)
                        if error:
                            self._state["error"] = error
                self._send("config", {"strength": s["strength"], "autotune": s["autotune"], "boost": s["boost"]})
            self._listening = mics.listening() if s["engine"] else []
        self._ensure_watcher()
        self._publish()

    def _alive(self) -> bool:
        return self._proc is not None and self._proc.is_alive()

    def _start(self, names: list[str], output: str = "") -> None:
        from . import voice_engine

        ctx = mp.get_context("spawn")
        self._cmd, self._status = ctx.Queue(), ctx.Queue()
        self._proc = ctx.Process(target=voice_engine.run, args=(self._cmd, self._status, names, output), name="voce", daemon=True)
        self._proc.start()
        self._mic_names = names
        self._out_name = output
        self._state = {"running": False, "latency_ms": 0, "mics": len(names), "error": "", "correction_cents": 0, "singing": False}
        log.info("Motore voce in avvio con %s, uscita %s", names, output or "predefinita")
        self._song_id = ""  # al primo stato del player si rimanda la melodia

    def _stop(self) -> None:
        if self._proc is not None:
            self._send("stop", None)
            self._proc.join(timeout=2)
            if self._proc.is_alive():
                self._proc.terminate()
        self._proc = self._cmd = self._status = None
        self._mic_names = []
        self._out_name = ""
        self._state = {"running": False, "latency_ms": 0, "mics": 0, "error": "", "correction_cents": 0, "singing": False}

    def shutdown(self) -> None:
        with self._lock:
            self._stop()

    def _send(self, kind: str, data) -> None:
        if self._cmd is not None:
            try:
                self._cmd.put_nowait((kind, data))
            except Exception:
                pass

    def _ensure_watcher(self) -> None:
        if self._watcher is None:
            self._watcher = threading.Thread(target=self._watch, name="voce-controllo", daemon=True)
            self._watcher.start()

    def _watch(self) -> None:
        """Legge lo stato del motore e si accorge di microfoni collegati o scollegati."""
        last_check = 0.0
        while True:
            time.sleep(0.5)
            q = self._status
            while q is not None:
                try:
                    kind, data = q.get_nowait()
                except Exception:
                    break
                if kind == "log":
                    log.warning("Motore voce: %s", data)
                    continue
                if kind == "status":
                    before = dict(self._state)
                    self._state = {k: data.get(k, v) for k, v in self._state.items()}
                    if self._state.get("error"):
                        self._failed_at, self._failed_names = time.monotonic(), list(self._mic_names)
                        if self._state["error"] != before.get("error"):
                            log.warning("Motore voce: %s", self._state["error"])
                    elif self._state["running"] and not before.get("running"):
                        log.info("Motore voce avviato: %d microfoni, ritardo ~%d ms", self._state["mics"], self._state["latency_ms"])
                    self._publish()
            if time.monotonic() - last_check > 4:
                last_check = time.monotonic()
                if self.settings()["engine"]:
                    try:
                        self.apply()
                    except Exception:
                        log.exception("Controllo del motore voce")

    # ------------------------------------------------------------ brano in corso
    def on_player(self, state: dict | None) -> None:
        """Posizione del player sulla TV: il motore sa quale nota si dovrebbe cantare adesso.

        A fine brano (parte il successivo, o la musica si ferma) l'autotune si spegne da solo: chi
        canta dopo parte con la propria voce e lo riaccende se vuole. La voce continua a passare da
        SingITnow (senza correzione), quindi non serve toccare niente in Windows.
        """
        song_id = (state or {}).get("song_id", "")
        if self._playing_song and song_id != self._playing_song:
            if self.settings()["autotune"]:
                threading.Thread(target=self.update, kwargs={"autotune": False}, name="voce-fine-brano", daemon=True).start()
        self._playing_song = song_id
        if self._cmd is None:
            return
        if state is None:
            self._send("clock", {"t": 0.0, "playing": False, "key": 0, "at": time.monotonic()})
            return
        song_id = state.get("song_id", "")
        if song_id != self._song_id:
            self._song_id = song_id
            notes = []
            try:
                data = json.loads((config.LIBRARY_DIR / song_id / "pitch.json").read_text(encoding="utf-8"))
                notes = [n[:3] for n in data.get("notes", [])]
            except (OSError, ValueError):
                pass
            self._send("melody", {"song_id": song_id, "notes": notes})
        self._send(
            "clock",
            {
                "t": float(state.get("t", 0)),
                "playing": bool(state.get("playing")),
                "key": int(state.get("key") or 0),
                "at": time.monotonic(),
            },
        )


voice = Voice()
