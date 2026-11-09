"""Elaborazione della voce per l'autotune, compilata con numba (campione per campione, in tempo reale).

- detect_pitch: frequenza fondamentale della voce (algoritmo YIN) sugli ultimi campioni ricevuti;
- Shifter: cambia l'intonazione senza cambiare la durata, con due «testine» di lettura su una linea
  di ritardo che scorrono a velocità diversa da quella di scrittura e si scambiano in dissolvenza.
  La finestra è pari a due periodi della voce: le due testine restano in fase (niente effetto
  «metallico») e il ritardo aggiunto è circa un periodo (5–15 ms).
"""

from __future__ import annotations

import math

import numpy as np
from numba import njit

BUF = 8192  # campioni della linea di ritardo (potenza di 2)
MASK = BUF - 1


@njit(cache=True, fastmath=True)
def detect_pitch(x: np.ndarray, sr: float, fmin: float, fmax: float) -> float:
    """Frequenza (Hz) della voce in x (YIN), 0 se silenzio o suono non intonato."""
    n = x.shape[0]
    rms = 0.0
    for i in range(n):
        rms += x[i] * x[i]
    rms = math.sqrt(rms / n)
    if rms < 0.004:
        return 0.0
    tau_min = int(sr / fmax)
    tau_max = min(int(sr / fmin), n // 2)
    w = n - tau_max
    d = np.empty(tau_max + 1)
    d[0] = 1.0
    running = 0.0
    found = -1
    for tau in range(1, tau_max + 1):
        s = 0.0
        for j in range(w):
            v = x[j] - x[j + tau]
            s += v * v
        running += s
        d[tau] = s * tau / running if running > 0 else 1.0
        if found < 0 and tau > tau_min + 1 and d[tau - 1] < 0.15 and d[tau - 1] <= d[tau]:
            found = tau - 1
            break
    if found < 1:
        return 0.0
    a, b, c = d[found - 1], d[found], d[found + 1]
    den = a + c - 2 * b
    t = found + (a - c) / (2 * den) if den != 0 else float(found)
    return sr / t


@njit(cache=True, fastmath=True)
def shift_block(
    x: np.ndarray, out: np.ndarray, buf: np.ndarray, state: np.ndarray, ratio: float, window: float
) -> None:
    """Cambia l'intonazione di x di `ratio` (2 = un'ottava sopra) e scrive in out.

    state = [indice di scrittura, fase (0..1), finestra corrente]: resta da un blocco all'altro.
    """
    w = int(state[0])
    phase = state[1]
    win = state[2] if state[2] > 0 else window
    dmin = 32.0  # margine minimo di ritardo (campioni)
    for i in range(x.shape[0]):
        buf[w & MASK] = x[i]
        # la finestra cambia solo quando una testina passa per il centro (nessuno scatto udibile)
        step = (1.0 - ratio) / win
        phase += step
        if phase >= 1.0:
            phase -= 1.0
            win = window
        elif phase < 0.0:
            phase += 1.0
            win = window
        y = 0.0
        for k in range(2):
            p = phase + 0.5 * k
            if p >= 1.0:
                p -= 1.0
            delay = dmin + p * win
            pos = w - delay
            i0 = int(math.floor(pos))
            frac = pos - i0
            s = buf[i0 & MASK] * (1.0 - frac) + buf[(i0 + 1) & MASK] * frac
            g = 0.5 - 0.5 * math.cos(2.0 * math.pi * p)  # le due finestre sommano sempre a 1
            y += g * s
        out[i] = y
        w += 1
    state[0] = w
    state[1] = phase
    state[2] = win


# Intensità dell'autotune (cursore 0–1), con le stesse soglie delle etichette dell'app:
# Leggero sotto 0,34, Medio fino a 0,75, Robotico oltre.
MEDIUM, ROBOTIC = 0.34, 0.75


def correction_amount(strength: float) -> float:
    """Quota della stonatura che viene corretta (1 = tutta)."""
    if strength < MEDIUM:
        return 0.25 + strength  # Leggero: circa metà
    if strength < ROBOTIC:
        # Medio: quasi tutta (85% → 100%), si sente che la voce è intonata
        return 0.85 + 0.15 * (strength - MEDIUM) / (ROBOTIC - MEDIUM)
    return 1.0


def correction_time(strength: float) -> float:
    """Velocità di correzione (s): lenta = naturale, immediata = effetto «robotico».
    Leggero ~60-120 ms, Medio 35 → 20 ms (deciso ma senza scatti: sotto ~15 ms le note
    diventano gradini e la voce suona robotica), Robotico 10 → 3 ms."""
    if MEDIUM <= strength < ROBOTIC:
        return 0.035 - 0.015 * (strength - MEDIUM) / (ROBOTIC - MEDIUM)
    return 0.003 + 0.12 * (1.0 - strength) ** 2


class Tuner:
    """Autotune di un microfono: stima della nota cantata, nota obiettivo, correzione morbida."""

    def __init__(self, sr: float) -> None:
        self.sr = sr
        self.buf = np.zeros(BUF, dtype=np.float32)
        self.state = np.zeros(3)
        self.hist = np.zeros(2048, dtype=np.float32)  # ~43 ms a 48 kHz per riconoscere la nota
        self.shift = 0.0  # correzione attuale in semitoni
        self.window = sr / 110.0 * 2  # due periodi
        self.sung = 0.0  # nota cantata (MIDI) dell'ultimo blocco, 0 = nessuna
        self.acc = 0.0  # somma delle correzioni (semitoni) dall'ultimo resoconto
        self.count = 0  # blocchi con voce dall'ultimo resoconto
        self.blocks = 0  # blocchi ricevuti dall'ultimo resoconto

    def report(self) -> tuple[float, float]:
        """(correzione media in semitoni, quota di tempo con voce) dall'ultimo resoconto."""
        avg = self.acc / self.count if self.count else 0.0
        voiced = self.count / self.blocks if self.blocks else 0.0
        self.acc, self.count, self.blocks = 0.0, 0, 0
        return avg, voiced

    def process(self, x: np.ndarray, target_fn, strength: float, enabled: bool) -> np.ndarray:
        """x: blocco del microfono (float32). target_fn(midi) -> nota obiettivo o None."""
        n = x.shape[0]
        self.blocks += 1
        if not enabled:
            # autotune spento: la voce passa così com'è (nessun ritardo aggiunto)
            self.shift = 0.0
            self.state[:] = 0.0
            self.sung = 0.0
            return x.copy()
        if n >= self.hist.shape[0]:
            self.hist[:] = x[-self.hist.shape[0]:]
        else:
            self.hist[:-n] = self.hist[n:]
            self.hist[-n:] = x
        f0 = detect_pitch(self.hist, self.sr, 70.0, 1000.0)
        want = 0.0
        if f0 > 0:
            midi = 69.0 + 12.0 * math.log2(f0 / 440.0)
            self.sung = midi
            self.window = min(max(2.0 * self.sr / f0, self.sr * 0.006), self.sr * 0.03)
            if enabled and strength > 0:
                target = target_fn(midi)
                if target is not None:
                    want = (target - midi) * correction_amount(strength)
        else:
            self.sung = 0.0
        tau = correction_time(strength)
        alpha = 1.0 - math.exp(-n / (self.sr * tau))
        self.shift += (want - self.shift) * alpha
        # per l'indicatore «quanto sto correggendo» (media dei blocchi con voce)
        if f0 > 0:
            self.acc += abs(self.shift)
            self.count += 1
        out = np.empty_like(x)
        shift_block(x, out, self.buf, self.state, 2.0 ** (self.shift / 12.0), self.window)
        return out


def nearest_target(midi: float, melody: float | None) -> float:
    """Nota obiettivo: quella della melodia all'ottava più vicina a chi canta; se chi canta è lontano
    più di 2,5 semitoni (o non c'è melodia in quel momento) il semitono più vicino."""
    if melody is not None:
        m = melody + 12.0 * round((midi - melody) / 12.0)
        if abs(m - midi) <= 2.5:
            return m
    return float(round(midi))


# ------------------------------------------------------------------ pulizia del microfono
@njit(cache=True, fastmath=True)
def clean_block(x: np.ndarray, coef: np.ndarray, st: np.ndarray) -> None:
    """Passa-alto (toglie ronzio e rimbombi sotto ~80 Hz) e noise gate morbido, sul posto.

    coef = [b0, b1, b2, a1, a2, attacco, rilascio, soglia apertura, soglia chiusura, guadagno a gate chiuso]
    st = [x1, x2, y1, y2, inviluppo, guadagno, tenuta (campioni), aperto]
    Il gate segue l'inviluppo della voce: si apre in un paio di millisecondi appena si canta e si
    richiude piano (dopo una breve tenuta) quando si smette, così le code delle frasi non vengono
    tagliate. A gate chiuso il microfono non è muto del tutto ma molto più basso: suona naturale.
    """
    b0, b1, b2, a1, a2 = coef[0], coef[1], coef[2], coef[3], coef[4]
    att, rel, open_th, close_th, floor = coef[5], coef[6], coef[7], coef[8], coef[9]
    x1, x2, y1, y2, env, g, hold, is_open = st[0], st[1], st[2], st[3], st[4], st[5], st[6], st[7]
    hold_len = 0.12 * coef[10]
    for i in range(x.shape[0]):
        v = x[i]
        y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1, y2, y1 = x1, v, y1, y
        a = abs(y)
        env += (a - env) * (0.01 if a > env else 0.0005)  # inviluppo: sale in fretta, scende piano
        if env > open_th:
            is_open = 1.0
            hold = hold_len
        elif env < close_th:
            if hold > 0:
                hold -= 1
            else:
                is_open = 0.0
        want = 1.0 if is_open > 0 else floor
        g += (want - g) * (att if want > g else rel)
        x[i] = y * g
    st[0], st[1], st[2], st[3], st[4], st[5], st[6], st[7] = x1, x2, y1, y2, env, g, hold, is_open


class Cleaner:
    """Passa-alto a 80 Hz + noise gate per un microfono (stato fra un blocco e l'altro)."""

    def __init__(self, sr: float, hp_hz: float = 80.0, open_db: float = -50.0, close_db: float = -56.0,
                 floor_db: float = -30.0) -> None:
        w = 2 * math.pi * hp_hz / sr
        q = 1 / math.sqrt(2)
        al = math.sin(w) / (2 * q)
        cw = math.cos(w)
        a0 = 1 + al
        # coefficienti di un passa-alto di Butterworth del secondo ordine (RBJ)
        self.coef = np.array([
            (1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, -2 * cw / a0, (1 - al) / a0,
            1 - math.exp(-1 / (0.002 * sr)),  # attacco ~2 ms
            1 - math.exp(-1 / (0.15 * sr)),  # rilascio ~150 ms
            10 ** (open_db / 20), 10 ** (close_db / 20), 10 ** (floor_db / 20), sr,
        ])
        self.st = np.zeros(8)
        self.st[5] = 10 ** (floor_db / 20)

    def process(self, x: np.ndarray) -> None:
        clean_block(x, self.coef, self.st)


@njit(cache=True, fastmath=True)
def boost_block(x: np.ndarray, boost: float, st: np.ndarray, release: float) -> None:
    """Amplifica la voce di `boost` e la tiene sotto 0 dBFS con un limitatore, sul posto.

    st = [guadagno del limitatore]: scende all'istante sui picchi (niente distorsione) e risale
    piano (`release` per campione), così il volume non «pompa».
    """
    ceil = 0.89  # -1 dBFS: margine per la conversione verso le casse
    g = st[0]
    for i in range(x.shape[0]):
        v = x[i] * boost
        a = abs(v)
        if a * g > ceil:
            g = ceil / a
        else:
            g += (1.0 - g) * release
        x[i] = v * g
    st[0] = g


class Booster:
    """Volume della voce oltre il 100% con limitatore (stato fra un blocco e l'altro)."""

    def __init__(self, sr: float) -> None:
        self.st = np.ones(1)
        self.release = 1 - math.exp(-1 / (0.2 * sr))  # ~200 ms

    def process(self, x: np.ndarray, boost: float) -> None:
        boost_block(x, boost, self.st, self.release)
