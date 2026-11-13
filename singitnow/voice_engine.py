"""Motore audio della voce (processo separato, bassa latenza): microfoni -> autotune -> casse.

Gira in un processo a parte, così l'audio non viene mai rallentato dal server, dagli scaricamenti o
da Whisper. Usa WASAPI in modalità condivisa (le casse restano disponibili anche per il video) con
blocchi piccolissimi. Riceve comandi dal server tramite una coda:

    ("config", {"strength": 0..1, "autotune": bool, "boost": 1..4, "gains": [..]})
    ("melody", {"song_id": str, "notes": [[inizio, fine, midi], ...]})
    ("clock", {"t": s, "playing": bool, "key": semitoni, "at": time.monotonic()})
    ("stop", None)

e manda indietro lo stato: ("status", {"running", "latency_ms", "mics", "error"}) e ("log", testo).
"""

from __future__ import annotations

import bisect
import logging
import queue
import time

import numpy as np

SR = 48000
BLOCK = 240  # 5 ms
RING = SR  # 1 s di margine per microfono
MIC_FADE = 0.15  # s: il microfono si apre e si chiude con una breve sfumatura
MIC_TIMEOUT = 3.0  # s: senza notizie dal player il microfono si chiude

log = logging.getLogger(__name__)


FADE = 64  # campioni di dissolvenza su buchi e salti (~1,3 ms): niente scatti udibili
TARGET_MIN = 3 * BLOCK  # margine iniziale fra microfono e casse (15 ms)
TARGET_MAX = 10 * BLOCK  # margine massimo dopo i buchi (50 ms)
CALM = 10 * SR  # campioni senza buchi dopo i quali il margine scende di un blocco (10 s)
QUIET = 0.01  # sotto questo picco il blocco è silenzio: lì il salto avanti non si sente
UPGRADE_EVERY = 20.0  # s: ogni quanto riprovare le casse in modalità esclusiva se si è rimasti sulla condivisa


class _Ring:
    """Coda circolare fra il microfono e le casse (letta e scritta da thread diversi di PortAudio).

    In WASAPI condiviso Windows consegna l'audio a pacchetti (di solito 10 ms), e microfono e casse
    non arrivano mai allo stesso istante: la coda tiene un margine (`target`) per assorbire questi
    sbalzi. Se si svuota lo stesso, la voce sfuma invece di interrompersi di colpo e il margine
    cresce; dopo 10 s senza buchi riscende di un blocco alla volta, così un buco isolato non lascia
    la voce in ritardo per tutta la serata. Se si riempie troppo (orologi diversi fra microfono e casse) si salta avanti con una
    dissolvenza incrociata. Senza dissolvenze ogni buco o salto è uno scatto, e tanti scatti di
    fila si sentono come un fruscio forte sulla voce.
    """

    def __init__(self) -> None:
        self.buf = np.zeros(RING, dtype=np.float32)
        self.w = 0
        self.r = 0
        self.target = TARGET_MIN
        self.playing = False  # False = si aspetta di avere il margine prima di ripartire
        self.underruns = 0
        self.skips = 0
        self.calm = 0  # campioni letti dall'ultimo buco (o dall'ultima discesa del margine)
        # ritardo in più rispetto al margine: è il minimo su mezzo secondo, perché fra un pacchetto
        # e l'altro del microfono la coda oscilla di suo e quell'oscillazione non va tolta
        self.low = RING
        self.span = 0
        self.extra = 0
        self._ramp_in = np.linspace(0.0, 1.0, FADE, dtype=np.float32)
        self._ramp_out = self._ramp_in[::-1].copy()

    def write(self, x: np.ndarray) -> None:
        n = len(x)
        i = self.w % RING
        k = min(n, RING - i)
        self.buf[i : i + k] = x[:k]
        self.buf[: n - k] = x[k:]
        self.w += n

    def _get(self, start: int, n: int) -> np.ndarray:
        i = start % RING
        k = min(n, RING - i)
        return np.concatenate([self.buf[i : i + k], self.buf[: n - k]])

    def read(self, n: int) -> np.ndarray | None:
        avail = self.w - self.r
        if not self.playing:
            if avail < self.target + n:
                return None
            # si riparte dal margine giusto, con una salita di volume
            self.r = self.w - self.target - n
            out = self._get(self.r, n)
            out[:FADE] *= self._ramp_in
            self.r += n
            self.playing = True
            return out
        if avail < n:
            # buco: quel che c'è sfuma a zero, poi si aspetta un margine più ampio
            self.underruns += 1
            self.target = min(TARGET_MAX, self.target + BLOCK)
            self.calm = 0
            self.playing = False
            m = min(avail, FADE)
            if m <= 0:
                return None
            out = np.zeros(n, dtype=np.float32)
            out[:m] = self._get(self.r, m) * self._ramp_out[FADE - m :]
            self.r += m
            return out
        self.calm += n
        if self.calm >= CALM and self.target > TARGET_MIN:
            # nessun buco da un po': il margine scende di un blocco
            self.target -= BLOCK
            self.calm = 0
        excess = avail - (self.target + n)
        self.low = min(self.low, excess)
        self.span += n
        if self.span >= SR // 2:
            self.extra = max(0, self.low)
            self.low, self.span = RING, 0
        jump = 0
        if excess > 4 * BLOCK:
            jump = excess  # troppo ritardo accumulato: subito al margine giusto
        elif self.extra >= BLOCK and float(np.abs(self._get(self.r, n)).max(initial=0.0)) < QUIET:
            jump = self.extra  # ritardo in più dopo una discesa del margine: si toglie nel silenzio
        if jump:
            # salto avanti con dissolvenza incrociata
            self.skips += 1
            self.extra = 0
            self.low, self.span = RING, 0
            old = self._get(self.r, FADE)
            self.r += jump
            out = self._get(self.r, n)
            out[:FADE] = old * self._ramp_out + out[:FADE] * self._ramp_in
            self.r += n
            return out
        out = self._get(self.r, n)
        self.r += n
        return out


def _wasapi(sd, kind: str):
    """Indice dell'API WASAPI e del dispositivo predefinito (input o output)."""
    for i, h in enumerate(sd.query_hostapis()):
        if "WASAPI" in h["name"]:
            return i, h["default_output_device" if kind == "output" else "default_input_device"]
    return None, None


def _find_input(sd, name: str, api: int | None) -> int | None:
    """Microfono con quel nome: prima fra i dispositivi WASAPI, poi con le altre interfacce di Windows."""
    devs = list(enumerate(sd.query_devices()))
    for same_api in (True, False):
        for i, d in devs:
            if d["max_input_channels"] > 0 and (d["hostapi"] == api) == same_api and d["name"] == name:
                return i
        for i, d in devs:  # nomi a volte troncati
            if d["max_input_channels"] > 0 and (d["hostapi"] == api) == same_api and (
                name.startswith(d["name"]) or d["name"].startswith(name)
            ):
                return i
    return None


def _find_output(sd, name: str, api: int | None) -> int | None:
    """Uscita WASAPI con quel nome (nomi a volte troncati)."""
    devs = [(i, d) for i, d in enumerate(sd.query_devices()) if d["max_output_channels"] > 0 and d["hostapi"] == api]
    for i, d in devs:
        if d["name"] == name:
            return i
    for i, d in devs:
        if name.startswith(d["name"]) or d["name"].startswith(name):
            return i
    return None


def _open_output(sd, api, default_dev, name: str, shared, callback, note, tries: int = 6):
    """Casse della voce: (stream, esclusiva?, si può provare l'esclusiva?).

    Su un'uscita scelta apposta (non quella predefinita, dove suonano video e musica) si prova la
    modalità esclusiva: Windows non mescola né ricampiona, e il ritardo scende da ~22 a ~8 ms. Appena
    riavviata l'app le casse possono essere ancora occupate per un attimo (dal motore precedente o da
    un altro programma): si riprova qualche volta, poi si usa la condivisa (e lo si scrive nel log)."""
    dev = _find_output(sd, name, api) if name else None
    if name and dev is None:
        note("Uscita %r non trovata: uso quella predefinita" % name)
    can_exclusive = dev is not None and dev != default_dev
    if can_exclusive:
        err = None
        for i in range(tries):
            try:
                s = sd.OutputStream(
                    device=dev, channels=2, samplerate=SR, blocksize=BLOCK, dtype="float32", latency="low",
                    extra_settings=sd.WasapiSettings(exclusive=True), callback=callback,
                )
                return s, True, True
            except Exception as e:
                err = e
                if i + 1 < tries:
                    time.sleep(0.5)
        if tries > 1:
            note("Casse %r in modalità esclusiva non disponibili (%s): uso la condivisa, ritardo più alto" % (name, err))
    s = sd.OutputStream(
        device=dev if dev is not None else default_dev, channels=2, samplerate=SR, blocksize=BLOCK,
        dtype="float32", latency="low", extra_settings=shared, callback=callback,
    )
    return s, False, can_exclusive


def run(cmd_q, status_q, mic_names: list[str], output: str = "") -> None:
    """Corpo del processo del motore audio. output: uscita della voce ("" = predefinita di Windows)."""
    import sounddevice as sd

    from .voice_dsp import Booster, Cleaner, Tuner, nearest_target

    cfg = {"strength": 0.6, "autotune": True, "boost": 1.0, "gains": [1.0, 1.0]}
    melody: dict = {"starts": [], "notes": []}
    clock = {"t": 0.0, "playing": False, "key": 0, "at": time.monotonic(), "recv": 0.0}

    def song_time() -> float:
        return clock["t"] + (time.monotonic() - clock["at"] if clock["playing"] else 0.0)

    def melody_note() -> float | None:
        if not clock["playing"] or not melody["notes"]:
            return None
        t = song_time()
        i = bisect.bisect_right(melody["starts"], t) - 1
        if i >= 0:
            s, e, m = melody["notes"][i]
            if s <= t <= e + 0.05:
                # la nota del cantante originale è misurata (es. 60,4): l'obiettivo è il semitono giusto
                return round(m) + clock["key"]
        return None

    def status(**kw) -> None:
        try:
            status_q.put_nowait(("status", kw))
        except Exception:
            pass

    def note(msg: str) -> None:
        """Messaggio per il log dell'app (il motore è un processo a parte, senza log suo)."""
        try:
            status_q.put_nowait(("log", msg))
        except Exception:
            pass

    Cleaner(SR).process(np.zeros(BLOCK, dtype=np.float32))  # compila subito, non sul primo blocco audio
    Booster(SR).process(np.zeros(BLOCK, dtype=np.float32), 1.0)
    api, out_dev = _wasapi(sd, "output")
    settings = sd.WasapiSettings(exclusive=False, auto_convert=True) if api is not None else None
    rings: list[_Ring] = []
    tuners: list = []
    streams = []
    try:
        for idx, name in enumerate(mic_names[:2]):
            dev = _find_input(sd, name, api)
            if dev is None:
                log.warning("Microfono %r non trovato in WASAPI", name)
                continue
            ring = _Ring()
            tuner = Tuner(SR)
            cleaner = Cleaner(SR)
            rings.append(ring)
            tuners.append(tuner)

            def on_input(indata, frames, t, st, ring=ring, tuner=tuner, cleaner=cleaner, idx=idx):
                x = indata[:, 0].astype(np.float32, copy=True)
                cleaner.process(x)  # via ronzio sotto 80 Hz e fruscio di fondo quando non si canta
                gain = cfg["gains"][idx] if idx < len(cfg["gains"]) else 1.0
                y = tuner.process(x, lambda m: nearest_target(m, melody_note()), cfg["strength"], cfg["autotune"])
                ring.write(y * gain)

            wasapi = sd.query_devices(dev)["hostapi"] == api
            s = sd.InputStream(
                device=dev, channels=1, blocksize=BLOCK, dtype="float32", latency="low",
                # WASAPI converte da sé alla frequenza del motore; le altre interfacce usano quella del microfono
                samplerate=SR if wasapi else int(sd.query_devices(dev)["default_samplerate"]),
                extra_settings=settings if wasapi else None, callback=on_input,
            )
            if not wasapi and int(s.samplerate) != SR:
                s.close()
                log.warning("Microfono %r: frequenza %s non supportata", name, s.samplerate)
                continue
            streams.append(s)
        if not rings:
            status(running=False, latency_ms=0, mics=0, error="Nessun microfono disponibile")
            return

        booster = Booster(SR)
        # Microfono aperto solo con un brano in riproduzione: nella schermata principale, nel pannello
        # dei punteggi o con il brano in pausa la voce non va alle casse. Il player manda il suo stato
        # circa una volta al secondo: senza notizie per MIC_TIMEOUT secondi (pagina chiusa) si chiude.
        gate = {"g": 0.0}
        step = BLOCK / (MIC_FADE * SR)  # di quanto si apre o chiude a ogni blocco

        def on_output(outdata, frames, t, st):
            mix = np.zeros(frames, dtype=np.float32)
            for ring in rings:
                x = ring.read(frames)
                if x is not None:
                    mix += x
            open_ = clock["playing"] and time.monotonic() - clock["recv"] < MIC_TIMEOUT
            g0 = gate["g"]
            g1 = min(1.0, g0 + step) if open_ else max(0.0, g0 - step)
            gate["g"] = g1
            if g0 == g1 == 0.0:
                mix[:] = 0.0
            elif g0 != 1.0 or g1 != 1.0:
                mix *= np.linspace(g0, g1, frames, dtype=np.float32)
            booster.process(mix, cfg["boost"])  # volume della voce oltre il 100%, senza distorcere
            outdata[:] = mix[:, None]

        out, exclusive, can_exclusive = _open_output(sd, api, out_dev, output, settings, on_output, note)
        streams.append(out)
        for s in streams:
            s.start()
        lat_in = max(s.latency for s in streams[:-1])

        def base_state() -> dict:
            # ritardo di base: ingresso + uscita + coda fra i due (l'autotune aggiunge ~10 ms, lo somma il server)
            lat = (lat_in + out.latency + (TARGET_MIN + BLOCK) / SR) * 1000
            return {"running": True, "latency_ms": round(lat), "mics": len(rings), "error": ""}

        base = base_state()
        status(**base, correction_cents=0, singing=False)

        last_report = time.monotonic()
        last_upgrade = time.monotonic()
        import multiprocessing

        parent = multiprocessing.parent_process()
        while True:
            # l'app che ci ha avviato non c'è più (chiusa male o terminata): ci si spegne, altrimenti
            # il motore resterebbe acceso da solo a mandare il microfono alle casse
            if parent is not None and not parent.is_alive():
                log.warning("App chiusa: il motore voce si spegne")
                break
            if (
                can_exclusive and not exclusive and gate["g"] == 0.0 and not clock["playing"]
                and time.monotonic() - last_upgrade >= UPGRADE_EVERY
            ):
                # casse rimaste in modalità condivisa: a microfono muto (nessun brano) si riprova
                # l'esclusiva, che ha meno ritardo; lo scambio dura un attimo e non si sente
                last_upgrade = time.monotonic()
                out.stop()
                out.close()
                streams.remove(out)
                out, exclusive, _ = _open_output(sd, api, out_dev, output, settings, on_output, note, tries=1)
                streams.append(out)
                out.start()
                if exclusive:
                    base = base_state()
                    note("Casse di nuovo in modalità esclusiva: ritardo ~%d ms" % base["latency_ms"])
            if time.monotonic() - last_report >= 1.0:
                # ogni secondo: quanto si sta correggendo la voce (per l'indicatore nell'app)
                last_report = time.monotonic()
                reports = [t.report() for t in tuners]
                corr = max((r[0] for r in reports), default=0.0)
                singing = max((r[1] for r in reports), default=0.0) > 0.2
                status(**base, correction_cents=round(corr * 100 / 5) * 5, singing=singing)
                for k, ring in enumerate(rings):
                    if ring.underruns or ring.skips:
                        msg = "Voce microfono %d: %d buchi, %d salti nell'ultimo secondo (margine %.0f ms)" % (
                            k + 1, ring.underruns, ring.skips, ring.target * 1000 / SR,
                        )
                        try:
                            status_q.put_nowait(("log", msg))
                        except Exception:
                            pass
                        ring.underruns = ring.skips = 0
            try:
                kind, data = cmd_q.get(timeout=0.25)
            except queue.Empty:
                continue
            if kind == "stop":
                break
            if kind == "config":
                cfg.update(data)
            elif kind == "clock":
                clock.update(data)
                clock["recv"] = time.monotonic()
            elif kind == "melody":
                notes = sorted(([float(n[0]), float(n[1]), float(n[2])] for n in data.get("notes", [])), key=lambda n: n[0])
                melody["notes"] = notes
                melody["starts"] = [n[0] for n in notes]
    except Exception as e:  # dispositivo occupato, scollegato…
        log.exception("Motore voce")
        status(running=False, latency_ms=0, mics=0, error=str(e))
    finally:
        for s in streams:
            try:
                s.stop()
                s.close()
            except Exception:
                pass
