"""Note della melodia cantata, ricavate dalla voce isolata (per le barre dell'intonazione).

Si stima l'altezza della voce fotogramma per fotogramma (pYIN di librosa) e la si raggruppa in
note: tratti in cui la voce resta stabile intorno allo stesso semitono. Le barre seguono poi le
parole del testo: ogni nota è ritagliata sulle parole cantate (niente barre nelle pause, dove la
voce isolata contiene cori, respiri e residui degli strumenti). Il risultato,
pitch.json, è un elenco di note [inizio, fine, nota MIDI] che il player confronta con la voce
presa dal microfono. Le parole del testo dove la voce non è riconoscibile con sicurezza ricevono
comunque una barra, marcata come incerta ([inizio, fine, nota, 1]): non conta nel punteggio.
"""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

SR = 16000
HOP = 320  # 20 ms
FRAME = 1024
MIN_NOTE = 0.12  # s: note più corte sono abbellimenti, non si cantano "a barra"
MAX_GAP = 0.06  # s: buchi brevi dentro una nota (consonanti) non la spezzano

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _load(path: Path) -> np.ndarray:
    """Audio mono a 16 kHz (decodifica con ffmpeg: va bene anche per gli m4a)."""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    out = subprocess.run(cmd, capture_output=True, creationflags=_NO_WINDOW)
    if out.returncode != 0:
        raise RuntimeError(f"ffmpeg: {out.stderr.decode(errors='ignore')[-300:]}")
    return np.frombuffer(out.stdout, dtype=np.float32)


VERSION = 6  # se cambia, le note dei brani già in libreria vengono ricalcolate all'avvio


LINE_PAD_BEFORE = 0.6  # s: margine prima di una riga del testo (attacchi anticipati)
LINE_PAD_AFTER = 1.0  # s: e dopo (note tenute in fondo alla frase)


def extract(vocals: Path, words: list[dict] | None = None, lines: list[dict] | None = None) -> dict:
    """words: parole del testo sincronizzato ({"s": inizio, "e": fine}); ogni parola cantata
    deve avere la sua barra, anche dove l'analisi della voce è incerta."""
    import librosa

    y = _load(vocals)
    # fill_na=None: anche nei tratti incerti si ha la frequenza più probabile (serve a riempire le parole)
    f0, voiced, prob = librosa.pyin(
        y, fmin=FMIN, fmax=1000.0, sr=SR, frame_length=FRAME, hop_length=HOP, center=True, fill_na=None
    )
    # le parti quasi mute della traccia voce (riverbero, rientri della base) non sono note
    rms = librosa.feature.rms(y=y, frame_length=FRAME, hop_length=HOP, center=True)[0]
    n = min(len(f0), len(rms))
    f0, voiced, prob, rms = f0[:n], voiced[:n], prob[:n], rms[:n]
    loud = rms > max(0.006, 0.05 * float(np.percentile(rms, 95)))
    # stime schiacciate sul limite basso della ricerca: non sono note, è l'analisi che non sa
    f0 = np.where(np.isfinite(f0) & (f0 > FMIN * 1.06), f0, np.nan)
    ok = loud & (voiced | (prob > 0.12)) & np.isfinite(f0)
    guess = librosa.hz_to_midi(f0)  # nota più probabile, sempre
    guess = _fix_octaves(guess, loud & voiced & (prob > 0.5))
    midi = np.full(n, np.nan)
    midi[ok] = guess[ok]
    dt = HOP / SR
    notes = _notes(midi, dt)
    # voce presente davvero: vicino al volume della sua riga (respiri, riverbero e residui no)
    singing = _singing(rms, lines or [], dt)
    if words:
        notes = _fill_words(notes, words, guess, singing, dt)
        notes = _only_words(notes, words)
    if lines:
        notes = _only_sung(notes, lines)
    return {"version": VERSION, "notes": notes}


FMIN = 70.0  # Hz: nota più bassa cercata
OCTAVE_MARGIN = 3.0  # semitoni oltre l'estensione del cantante prima di considerare un errore d'ottava


def _fix_octaves(midi: np.ndarray, sure: np.ndarray) -> np.ndarray:
    """Riporta nell'ottava giusta le stime che cadono un'ottava sotto (o sopra) l'estensione del cantante.

    Con voci profonde, riverbero o cori l'analisi spesso sente la voce un'ottava sotto quella vera
    (le barre saltano su e giù d'ottava dentro la stessa frase). L'estensione si ricava dai tratti in
    cui l'analisi è sicura; le altre stime fuori estensione si spostano d'ottava fino a rientrarci.
    """
    known = midi[sure & np.isfinite(midi)]
    if len(known) < 50:  # troppo poco per capire l'estensione: si lascia com'è
        return midi
    lo = float(np.percentile(known, 5)) - OCTAVE_MARGIN
    hi = float(np.percentile(known, 95)) + OCTAVE_MARGIN
    if hi - lo < 12:  # estensione stretta: si allarga a un'ottava intorno al centro
        mid = (hi + lo) / 2
        lo, hi = mid - 6, mid + 6
    out = midi.copy()
    fin = np.isfinite(out)
    low = fin & (out < lo)
    out[low] += 12 * np.ceil((lo - out[low]) / 12)
    high = fin & (out > hi)
    out[high] -= 12 * np.ceil((out[high] - hi) / 12)
    return out


WORD_PAD_BEFORE = 0.25  # s: attacco della nota un po' prima della parola
WORD_PAD_AFTER = 0.6  # s: nota tenuta dopo la fine della parola
PHRASE_RANGE_DB = 15.0  # la voce conta come cantato fino a tanti dB sotto il volume della riga


def _singing(rms: np.ndarray, lines: list[dict], dt: float) -> np.ndarray:
    """Per ogni fotogramma: True se la voce isolata è vicina al volume del cantato della sua riga."""
    db = 20 * np.log10(rms + 1e-9)
    base = max(float(np.percentile(db, 95)) - 28, -50)
    thr = np.full(len(db), base)
    for l in lines:
        a, b = int(float(l.get("start", 0)) / dt), int(float(l.get("end", 0)) / dt)
        if b - a > 5:
            thr[a:b] = max(base, float(np.percentile(db[a:b], 75)) - PHRASE_RANGE_DB)
    return db > thr


WORD_TAIL = 0.3  # s: dopo la fine di una parola la nota può ancora durare un attimo (vocale tenuta)
MIN_PIECE = 0.08  # s: pezzi di barra più corti non si disegnano
MIN_KEEP = 0.15  # s: dentro una parola, un cambio di nota più breve è un'oscillazione della voce


def _only_words(notes: list[list[float]], words: list[dict]) -> list[list[float]]:
    """Le barre seguono le parole del testo: ogni nota viene ritagliata sulle parole cantate.

    Una barra comincia quando comincia la parola (già allineata all'attacco della voce) e finisce
    con lei; se dentro una parola la melodia cambia nota, la parola ha più barre una dopo l'altra.
    Nelle pause fra le parole la voce isolata contiene cori, respiri e residui degli strumenti:
    lì non c'è niente da cantare e non compare nessuna barra.
    """
    spans: list[tuple[float, float]] = []
    ws = sorted((float(w.get("s", 0)), float(w.get("e", 0))) for w in words if float(w.get("e", 0)) > float(w.get("s", 0)))
    for i, (s, e) in enumerate(ws):
        nxt = ws[i + 1][0] if i + 1 < len(ws) else e + WORD_TAIL
        spans.append((s, max(e, min(e + WORD_TAIL, nxt))))  # la coda non invade la parola dopo
    notes = sorted(notes)
    out: list[list[float]] = []
    for s, e in spans:
        # pezzi delle note dentro questa parola (ogni parola ha le sue barre)
        pieces = [[max(n[0], s), min(n[1], e), *n[2:]] for n in notes if n[1] > s and n[0] < e]
        pieces = [p for p in pieces if p[1] - p[0] > 0.02]
        # la voce oscilla: i pezzetti troppo corti si uniscono al vicino più lungo della stessa parola
        while len(pieces) > 1:
            k = min(range(len(pieces)), key=lambda i: pieces[i][1] - pieces[i][0])
            if pieces[k][1] - pieces[k][0] >= MIN_KEEP:
                break
            nb = [i for i in (k - 1, k + 1) if 0 <= i < len(pieces)]
            j = max(nb, key=lambda i: pieces[i][1] - pieces[i][0])
            a, b = min(pieces[j][0], pieces[k][0]), max(pieces[j][1], pieces[k][1])
            pieces[j][0], pieces[j][1] = a, b
            del pieces[k]
        for p in pieces:
            # pezzi uguali e attaccati dentro la stessa parola: una barra sola
            if out and out[-1][0] >= s and out[-1][2:] == p[2:] and p[0] - out[-1][1] <= 0.05:
                out[-1][1] = round(p[1], 2)
            elif p[1] - p[0] >= MIN_PIECE:
                out.append([round(p[0], 2), round(p[1], 2), *p[2:]])
    return out


def _only_sung(notes: list[list[float]], lines: list[dict]) -> list[list[float]]:
    """Tiene solo le note dentro le righe del testo: nelle parti solo musicali (intro, assoli)
    la traccia voce separata contiene residui degli strumenti, che non sono da cantare."""
    spans = sorted(
        (float(l.get("start", 0)) - LINE_PAD_BEFORE, float(l.get("end", 0)) + LINE_PAD_AFTER)
        for l in lines
        if l.get("end", 0) > l.get("start", 0)
    )
    if not spans:
        return notes
    out = []
    for n in notes:
        mid = (n[0] + n[1]) / 2
        if any(a <= mid <= b for a, b in spans):
            out.append(n)
    return out


def _fill_words(notes: list[list[float]], words: list[dict], guess: np.ndarray, loud: np.ndarray, dt: float) -> list[list[float]]:
    """Le parte scoperte delle parole cantate diventano note (nota più probabile in quel tratto).

    Solo dove la voce c'è davvero (`loud`: cantato vicino al volume della riga): una parola con tempi
    stimati può coprire anche una pausa, e lì non deve comparire una barra.
    """
    notes = sorted(notes)
    added: list[list[float]] = []
    for w in words:
        s, e = float(w.get("s", 0)), float(w.get("e", 0))
        if e - s < 0.08:
            continue
        # tratti della parola non coperti da note
        gaps, cur = [], s
        for a, b, _ in notes:
            if b <= cur or a >= e:
                continue
            if a > cur:
                gaps.append((cur, a))
            cur = max(cur, b)
        if cur < e:
            gaps.append((cur, e))
        for a, b in gaps:
            if b - a < 0.1:
                continue
            i0, i1 = int(a / dt), max(int(b / dt), int(a / dt) + 1)
            voice = loud[i0:i1]
            if not len(voice) or voice.mean() < 0.5:
                continue  # in questo tratto la voce non c'è (pausa, respiro): niente barra
            seg = guess[i0:i1]
            seg = seg[np.isfinite(seg) & voice[: len(seg)]]
            if len(seg) < 3:
                continue
            m = float(np.median(seg))
            # quarto valore 1 = nota incerta: si vede, ma non conta nel punteggio
            added.append([round(a, 2), round(b, 2), round(m, 1), 1])
    return _merge(sorted(notes + added))


def _notes(midi: np.ndarray, dt: float) -> list[list[float]]:
    notes: list[list[float]] = []
    start = None
    vals: list[float] = []
    gap = 0

    def close(end_i: int) -> None:
        if start is None or not vals:
            return
        t0, t1 = start * dt, end_i * dt
        if t1 - t0 >= MIN_NOTE:
            notes.append([round(t0, 2), round(t1, 2), round(float(np.median(vals)), 1)])

    max_gap = int(round(MAX_GAP / dt))
    for i, m in enumerate(midi):
        if np.isnan(m):
            if start is not None:
                gap += 1
                if gap > max_gap:
                    close(i - gap + 1)
                    start, vals, gap = None, [], 0
            continue
        if start is not None and abs(m - float(np.median(vals[-8:]))) > 0.8:
            # cambio di nota: si chiude la precedente e se ne apre un'altra
            close(i - gap)
            start, vals = None, []
        if start is None:
            start = i
        vals.append(float(m))
        gap = 0
    close(len(midi) - gap)
    return _merge(notes)


def _merge(notes: list[list[float]]) -> list[list[float]]:
    """Unisce note vicine sullo stesso semitono (un vibrato non deve spezzare la barra)."""
    out: list[list[float]] = []
    for n in notes:
        same_kind = len(n) == len(out[-1]) if out else False  # certe con certe, incerte con incerte
        if out and same_kind and n[0] - out[-1][1] <= MAX_GAP * 2 and abs(n[2] - out[-1][2]) < 0.6:
            out[-1][1] = n[1]
        else:
            out.append(list(n))
    return out


def is_current(song_dir: Path) -> bool:
    """True se pitch.json c'è ed è stato calcolato con la versione attuale."""
    try:
        return json.loads((song_dir / "pitch.json").read_text(encoding="utf-8")).get("version") == VERSION
    except (OSError, ValueError):
        return False


def build(song_dir: Path) -> bool:
    """Crea pitch.json accanto a vocals.m4a. False se non è stato possibile."""
    vocals = song_dir / "vocals.m4a"
    if not vocals.exists():
        return False
    words = lines = None
    try:
        lyr = json.loads((song_dir / "lyrics.json").read_text(encoding="utf-8"))
        lines = lyr.get("lines", []) or None
        words = [w for line in lyr.get("lines", []) for w in line.get("words", [])]
    except (OSError, ValueError):
        pass
    data = extract(vocals, words, lines)
    tmp = song_dir / "pitch.json.tmp"
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(song_dir / "pitch.json")
    return True
