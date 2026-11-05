"""Copertina del disco: cercata sul catalogo pubblico di iTunes (gratuito, senza chiavi)."""

from __future__ import annotations

import logging
import re
import unicodedata
from pathlib import Path

import httpx

from . import config

log = logging.getLogger(__name__)

ITUNES = "https://itunes.apple.com/search"
SIZE = 600  # pixel: iTunes genera la copertina della dimensione richiesta
# versioni da evitare se il titolo cercato non le nomina
_UNWANTED = ("live", "remix", "karaoke", "instrumental", "strumentale", "acoustic", "acustica", "cover", "remaster")
# raccolte: a parità meglio l'album originale
_COMPILATION = ("greatest", "hits", "best of", "the best", "collection", "raccolta", "deluxe", "anthology", "1992-", "gold")


def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    text = re.sub(r"\(.*?\)|\[.*?\]", " ", text)  # "(Live)", "[Remastered]"…
    return " ".join("".join(ch if ch.isalnum() else " " for ch in text).split())


def find_cover_url(artist: str, title: str) -> str | None:
    if not title:
        return None
    try:
        r = httpx.get(
            ITUNES,
            params={"term": f"{artist} {title}".strip(), "entity": "song", "limit": 15, "country": "IT"},
            headers={"User-Agent": config.USER_AGENT},
            timeout=10,
        )
        r.raise_for_status()
        results = r.json().get("results", [])
    except (httpx.HTTPError, ValueError) as e:
        log.info("Copertina non disponibile (%s)", e)
        return None

    want_title, want_artist = _norm(title), _norm(artist)

    def score(x: dict) -> tuple:
        t, a = _norm(x.get("trackName", "")), _norm(x.get("artistName", ""))
        full = (x.get("trackName", "") + " " + x.get("collectionName", "")).lower()
        unwanted = any(u in full and u not in title.lower() for u in _UNWANTED)
        return (
            t == want_title,
            bool(want_artist) and (want_artist in a or a in want_artist),
            not unwanted,
            not any(c in x.get("collectionName", "").lower() for c in _COMPILATION),
            # a parità, l'uscita più vecchia: di solito l'album originale, non una raccolta
            -int(re.sub(r"\D", "", x.get("releaseDate", "9999"))[:8] or 99999999),
        )

    candidates = [x for x in results if x.get("artworkUrl100")]
    if not candidates:
        return None
    best = max(candidates, key=score)
    t = _norm(best.get("trackName", ""))
    same_title = t == want_title or (bool(t) and (want_title in t or t in want_title))
    if not same_title or not score(best)[1]:  # meglio nessuna copertina che quella di un'altra canzone
        return None
    return best["artworkUrl100"].replace("100x100bb", f"{SIZE}x{SIZE}bb")


def fetch_cover(artist: str, title: str, dest: Path) -> bool:
    """Scarica la copertina in `dest` (cover.jpg). Non solleva eccezioni: è un abbellimento."""
    url = find_cover_url(artist, title)
    if not url:
        return False
    try:
        r = httpx.get(url, timeout=15, follow_redirects=True, headers={"User-Agent": config.USER_AGENT})
        if r.status_code == 200 and r.content:
            dest.write_bytes(r.content)
            return True
    except httpx.HTTPError as e:
        log.info("Download copertina non riuscito: %s", e)
    return False
