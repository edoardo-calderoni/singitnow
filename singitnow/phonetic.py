"""Allineamento fonetico delle parole: dove comincia davvero ogni parola cantata.

Whisper trova le parole ma ne mette i confini con un'approssimazione di qualche decimo di secondo:
dentro una frase cantata legata la parola dopo risulta spesso cominciare ancora sulla vocale tenuta
della precedente. Qui un modello che riconosce i singoli suoni (MMS di Meta, addestrato per
l'allineamento forzato su oltre mille lingue, alfabeto latino senza accenti) allinea le lettere del
testo alla voce isolata, riga per riga, con l'algoritmo di Viterbi sulle probabilità CTC.

Il risultato non sostituisce i tempi della sincronizzazione (le fini delle parole, per esempio, le
segna peggio: questo tipo di modello vede l'attacco dei suoni, non quanto durano) ma li corregge dove
il disaccordo è netto: confrontato con 38 brani corretti a mano, gli inizi spostati in avanti di
almeno mezzo secondo erano giusti 4 volte su 5.
"""

from __future__ import annotations

import logging
import os
import threading
import unicodedata

import numpy as np

from . import config

log = logging.getLogger(__name__)

MODEL = "MahmoudAshraf/mms-300m-1130-forced-aligner"
_FRAME = 0.02  # s per uscita del modello (passo di 320 campioni a 16 kHz)
_FIRST_VOCAB = 4  # 0-3: blank, pad, </s>, unk

_model = None
_lock = threading.Lock()
_failed = False


def _get():
    """(modello, alfabeto) o None se il modello non è disponibile (niente rete al primo avvio, …)."""
    global _model, _failed
    with _lock:
        if _model is None and not _failed:
            try:
                import json

                import torch
                from huggingface_hub import snapshot_download
                from transformers import Wav2Vec2ForCTC

                path = snapshot_download(
                    MODEL,
                    cache_dir=str(config.MODELS_DIR / "phonetic"),
                    allow_patterns=["config.json", "model.safetensors", "vocab.json", "preprocessor_config.json"],
                )
                torch.set_num_threads(max(4, (os.cpu_count() or 8) // 2))
                model = Wav2Vec2ForCTC.from_pretrained(path).eval()
                with open(os.path.join(path, "vocab.json"), encoding="utf-8") as f:
                    vocab = json.load(f)
                _model = (model, vocab)
            except Exception:
                log.exception("Allineamento fonetico non disponibile: resto sui tempi di Whisper")
                _failed = True
        return _model


def _letters(word: str, vocab: dict) -> list[int]:
    text = unicodedata.normalize("NFKD", word.lower().replace("’", "'"))
    return [vocab[c] for c in text if vocab.get(c, -1) >= _FIRST_VOCAB]


def _emissions(model, audio: np.ndarray, a: float, b: float) -> np.ndarray:
    import torch

    x = audio[int(a * 16000) : int(b * 16000)].astype(np.float32)
    x = (x - x.mean()) / (x.std() + 1e-7)
    with torch.inference_mode():
        return torch.log_softmax(model(torch.from_numpy(x)[None]).logits[0], -1).numpy()


def _viterbi(lp: np.ndarray, toks: list[int]) -> list[tuple[int, int] | None]:
    """Percorso CTC più probabile (stati: blank, l1, blank, l2, …, blank): primo e ultimo frame di
    ogni lettera."""
    T, S = lp.shape[0], 2 * len(toks) + 1
    lab = np.zeros(S, dtype=int)
    lab[1::2] = toks
    neg = -1e30
    skip = np.zeros(S, dtype=bool)
    skip[3::2] = lab[3::2] != lab[1:-2:2]  # si salta il blank solo fra lettere diverse
    dp = np.full(S, neg)
    dp[0], dp[1] = lp[0, 0], lp[0, lab[1]]
    back = np.zeros((T, S), dtype=np.int8)
    idx = np.arange(S)
    for t in range(1, T):
        c1 = np.concatenate([[neg], dp[:-1]])
        c2 = np.where(skip, np.concatenate([[neg, neg], dp[:-2]]), neg)
        cand = np.stack([dp, c1, c2])
        k = cand.argmax(0)
        dp = cand[k, idx] + lp[t, lab]
        back[t] = k
    s = S - 1 if dp[S - 1] > dp[S - 2] else S - 2
    spans: dict[int, tuple[int, int]] = {}
    for t in range(T - 1, -1, -1):
        if s % 2:
            i = s // 2
            a, b = spans.get(i, (t, t))
            spans[i] = (min(a, t), max(b, t))
        s -= int(back[t, s])
    return [spans.get(i) for i in range(len(toks))]


def align_line(audio: np.ndarray, words: list[str], a: float, b: float) -> list[tuple[float, float] | None]:
    """Tempi (inizio, fine) di ogni parola cercati fra a e b secondi; None per le parole senza
    lettere dell'alfabeto (numeri, simboli, scritture non latine) o se il modello non c'è."""
    if audio is None:
        return [None] * len(words)
    got = _get()
    a, b = max(0.0, a), min(len(audio) / 16000, b)
    if got is None or b - a < 0.5:
        return [None] * len(words)
    model, vocab = got
    toks: list[int] = []
    owner: list[int] = []
    for i, w in enumerate(words):
        cs = _letters(w, vocab)
        toks += cs
        owner += [i] * len(cs)
    lp = _emissions(model, audio, a, b)
    if not toks or 2 * len(toks) + 1 > lp.shape[0]:
        return [None] * len(words)
    out: list[tuple[float, float] | None] = [None] * len(words)
    for span, i in zip(_viterbi(lp, toks), owner):
        if span is None:
            continue
        s, e = a + span[0] * _FRAME, a + (span[1] + 1) * _FRAME
        prev = out[i]
        out[i] = (s, e) if prev is None else (min(prev[0], s), max(prev[1], e))
    return out
