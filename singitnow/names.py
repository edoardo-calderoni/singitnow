"""Artista e titolo di un brano da importare: proposta dai dati di YouTube e correzione dei refusi.

Prima di importare, chi aggiunge il brano conferma (o corregge) artista e titolo: sono quelli usati per
cercare il testo, quindi devono essere giusti. Durante le feste qualche refuso scappa: ogni parola
scritta viene confrontata con quelle del titolo e del canale del video, e se è quasi uguale a una di
quelle (es. «Manskin» → «Måneskin», «Vasci» → «Vasco») si usa la grafia del video.
"""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

from . import youtube

WORD = re.compile(r"[^\W_]+(?:['’][^\W_]+)*", re.UNICODE)  # parole (con gli apostrofi: «L'amore»)
SIMILAR = 0.8  # somiglianza minima per considerare una parola un refuso di quella del video


def _plain(s: str) -> str:
    """Minuscole senza accenti né segni (per confrontare «Måneskin» con «maneskin»)."""
    s = unicodedata.normalize("NFKD", s.casefold())
    return "".join(c for c in s if not unicodedata.combining(c)).replace("ø", "o").replace("æ", "ae")


def _ratio(a: str, b: str) -> float:
    return SequenceMatcher(None, _plain(a), _plain(b)).ratio()


def guess(yt_title: str, channel: str) -> tuple[str, str]:
    """Artista e titolo proposti dai dati del video (si possono poi correggere)."""
    return youtube.guess_artist_title({"title": yt_title, "channel": channel})


def _styled(video: str, user: str) -> str:
    """La parola del video, ma con le maiuscole di chi scrive se il video è TUTTO MAIUSCOLO o minuscolo."""
    if video.isupper() or video.islower():
        if user.isupper() and len(user) > 1:
            return video.upper()
        return video[:1].upper() + video[1:].lower() if user[:1].isupper() else video.lower()
    return video


def _fix_words(text: str, vocabulary: list[str]) -> str:
    """Ogni parola quasi uguale a una del video prende la grafia del video."""

    def repl(m: re.Match) -> str:
        w = m.group(0)
        # la stessa parola a meno di accenti: si scrive con gli accenti del video (Maneskin → Måneskin);
        # se cambiano solo le maiuscole si lascia com'è stata scritta
        same = next((v for v in vocabulary if _plain(v) == _plain(w)), None)
        if same:
            return w if same.casefold() == w.casefold() else _styled(same, w)
        if len(w) < 4:  # parole cortissime: troppo facile scambiarle con un'altra
            return w
        best, score = None, 0.0
        for v in vocabulary:
            if len(v) >= 4 and abs(len(v) - len(w)) <= 2:
                r = _ratio(w, v)
                if r > score:
                    best, score = v, r
        return _styled(best, w) if best and score >= SIMILAR else w

    return WORD.sub(repl, text)


def correct(artist: str, title: str, yt_title: str, channel: str) -> tuple[str, str]:
    """Artista e titolo scritti dall'utente, con i refusi corretti in base ai dati del video."""
    artist, title = " ".join(artist.split()), " ".join(title.split())
    g_artist, g_title = guess(yt_title, channel)
    # tutto il campo quasi uguale alla proposta del video: si usa quella (refusi sparsi), a meno che
    # il video non sia scritto TUTTO MAIUSCOLO (allora si correggono solo le parole, più sotto)
    if g_artist and artist and not g_artist.isupper() and _plain(artist) != _plain(g_artist) and _ratio(artist, g_artist) >= 0.85:
        artist = g_artist
    if g_title and title and not g_title.isupper() and _plain(title) != _plain(g_title) and _ratio(title, g_title) >= 0.85:
        title = g_title
    vocabulary = WORD.findall(f"{yt_title} {channel} {g_artist} {g_title}")
    return _fix_words(artist, vocabulary), _fix_words(title, vocabulary)
