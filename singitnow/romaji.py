"""Testi giapponesi in romaji.

Il giapponese non separa le parole con spazi e chi canta al karaoke di solito non legge kanji e
kana: il testo si mostra in romaji (Hepburn, con cutlet + dizionario UniDic) diviso in parole, così
l'evidenziazione parola per parola funziona come per le altre lingue. Ogni parola ricorda il testo
originale (`orig`), che serve per l'allineamento forzato con Whisper e per mostrare la riga
originale sotto il romaji.
"""

from __future__ import annotations

import logging
import re
import threading

log = logging.getLogger(__name__)

# hiragana, katakana (anche a mezza larghezza) e kanji
_JA = re.compile(r"[぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]")
_KANA = re.compile(r"[぀-ヿㇰ-ㇿｦ-ﾟ]")

# letture del dizionario (formali) diverse da come si cantano
_SUNG = {"私": "watashi", "貴方": "anata"}

_katsu = None
_lock = threading.Lock()
_missing = False


def is_japanese(text: str) -> bool:
    """Contiene giapponese. Basta un kana: il solo kanji può essere cinese."""
    return bool(_KANA.search(text))


def has_ja_chars(text: str) -> bool:
    return bool(_JA.search(text))


def _get():
    global _katsu, _missing
    if _missing:
        return None
    with _lock:
        if _katsu is None:
            try:
                import cutlet

                k = cutlet.Cutlet()
                k.use_foreign_spelling = False  # «コーヒー» → «koohii», come si canta, non «coffee»
                for orig, roma in _SUNG.items():
                    k.add_exception(orig, roma)
                _katsu = k
            except Exception:  # pacchetto o dizionario mancanti: si mostra il testo originale
                log.exception("cutlet non disponibile: i testi giapponesi restano in kana/kanji")
                _missing = True
                return None
        return _katsu


def available() -> bool:
    return _get() is not None


def normalize(text: str) -> str:
    try:
        import cutlet
    except ImportError:
        return text
    return cutlet.normalize_text(text)


def words(text: str) -> list[tuple[str, int, int]] | None:
    """Divide il testo in parole romaji: (romaji, inizio, fine) con le posizioni nel testo normalizzato.

    Le parti che cutlet unisce senza spazio (verbo + desinenza: «aishi»+«teru») formano una parola
    sola; la punteggiatura si scarta. None se cutlet non è installato.
    """
    k = _get()
    if k is None:
        return None
    norm = normalize(text)
    with _lock:
        nodes = k.tagger(norm)
        tokens = k.romaji_tokens(nodes, capitalize=False)
    out: list[tuple[str, int, int]] = []
    pos = 0
    cur, c0, c1 = "", -1, -1
    for node, tok in zip(nodes, tokens):
        start = norm.find(node.surface, pos)
        if start < 0:
            start = pos
        end = start + len(node.surface)
        pos = end
        roma = tok.surface
        if any(ch.isalnum() for ch in roma):
            roma = "".join(ch for ch in roma if ch.isalnum() or ch in "'-")
            if not cur:
                c0 = start
            cur, c1 = cur + roma, end
        if cur and (tok.space or not any(ch.isalnum() for ch in tok.surface)):
            out.append((cur, c0, c1))
            cur = ""
    if cur:
        out.append((cur, c0, c1))
    return out
