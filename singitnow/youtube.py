"""Ricerca e download da YouTube tramite yt-dlp."""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any, Callable

import yt_dlp


def _js_runtimes() -> dict[str, dict]:
    """YouTube richiede un runtime JS per decifrare gli stream: preferiamo deno, poi node."""
    runtimes: dict[str, dict] = {}
    if shutil.which("deno"):
        runtimes["deno"] = {}
    if shutil.which("node"):
        runtimes["node"] = {}
    return runtimes or {"deno": {}}


def _base_opts() -> dict[str, Any]:
    return {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "js_runtimes": _js_runtimes(),
    }


def _best_thumbnail(entry: dict) -> str:
    vid = entry.get("id")
    if vid:
        # hqdefault esiste sempre ed è leggero.
        return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    thumbs = entry.get("thumbnails") or []
    return thumbs[-1]["url"] if thumbs else ""


# Parole tipiche dei titoli inglesi e italiani, per capire in che lingua è la canzone cercata
_EN_WORDS = set(
    "the a an you your i i'm im me my mine we us our they he she it it's is are am was were be been "
    "and or but of in on at to for with from by up down out over all no not don't dont can't cant won't "
    "love baby heart night day time life world girl boy man woman dance dream fire rain sun light "
    "like just never ever forever again tonight home want need know feel get got go gonna wanna "
    "what when where why who how this that these those one more yeah oh".split()
)
_IT_WORDS = set(
    "il lo la i gli le un uno una di del della dei delle da dal dalla in nel nella con su sul sulla per "
    "tra fra e ed o ma che chi non più piu mi ti si ci vi me te noi voi lui lei loro mio mia tuo tua "
    "suo sua sei sono è e' era siamo ho hai ha come quando dove perché perche cosa tutto tutti tutta "
    "amore cuore notte giorno vita mondo sole mare cielo sempre mai ancora ora adesso domani ieri "
    "bella bello ragazza ragazzo vorrei voglio senza dentro fuori casa anima particolari".split()
)
_ALREADY = re.compile(r"\b(official|ufficiale|videoclip|video\s*clip)\b", re.I)


def is_english(query: str) -> bool:
    """Stima se la ricerca riguarda una canzone con titolo inglese (in dubbio: italiano)."""
    words = re.findall(r"[a-zàèéìíòóùú']+", query.lower())
    if re.search(r"[àèéìíòóùú]", query.lower()):
        return False
    en = sum(w in _EN_WORDS or (len(w) > 4 and w.endswith("ing")) for w in words)
    it = sum(w in _IT_WORDS for w in words)
    if en != it:
        return en > it
    # nessun indizio dalle parole: in italiano quasi tutte le parole finiscono per vocale
    long = [w for w in words if len(w) > 2]
    if not long:
        return False
    vowel_end = sum(w[-1] in "aeiou" for w in long) / len(long)
    return vowel_end < 0.5


def official_query(query: str) -> str:
    """Aggiunge "Video ufficiale" (o "Official video" per titoli inglesi) per favorire il videoclip originale."""
    query = query.strip()
    if not query or _ALREADY.search(query):
        return query
    return f"{query} {'Official video' if is_english(query) else 'Video ufficiale'}"


def search(query: str, limit: int = 12) -> list[dict[str, Any]]:
    opts = _base_opts() | {"extract_flat": "in_playlist", "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    results = []
    for e in (info or {}).get("entries") or []:
        if not e or not e.get("id"):
            continue
        # Esclude canali/playlist e live
        if e.get("ie_key") not in (None, "Youtube") or e.get("live_status") == "is_live":
            continue
        results.append(
            {
                "youtube_id": e["id"],
                "title": e.get("title") or "",
                "channel": e.get("channel") or e.get("uploader") or "",
                "duration": e.get("duration") or 0,
                "thumbnail": _best_thumbnail(e),
                "url": f"https://www.youtube.com/watch?v={e['id']}",
            }
        )
    return results


_NOISE = re.compile(
    r"\s*[\(\[][^\)\]]*(official|video|audio|lyric|testo|visuali[sz]er|hd|4k|remaster|videoclip|clip)[^\)\]]*[\)\]]",
    re.IGNORECASE,
)


def guess_artist_title(info: dict) -> tuple[str, str]:
    """Ricava artista e titolo dai metadati YouTube (i video musicali spesso li hanno)."""
    artist = info.get("artist") or (info.get("artists") or [None])[0] or ""
    track = info.get("track") or ""
    if artist and track:
        return artist, track
    title = _NOISE.sub("", info.get("title") or "").strip()
    title = re.sub(r"\s+(ft\.?|feat\.?)\s+.*$", "", title, flags=re.IGNORECASE)
    for sep in (" - ", " – ", " — ", " | "):
        if sep in title:
            a, t = title.split(sep, 1)
            return a.strip(), t.strip().strip('"')
    channel = (info.get("channel") or info.get("uploader") or "").removesuffix("VEVO").strip()
    channel = re.sub(r"\s*-\s*Topic$", "", channel)
    return channel, title


def download(url: str, dest: Path, on_progress: Callable[[float], None]) -> dict[str, Any]:
    """Scarica il video (max 1080p) in dest/video.mp4. Restituisce i metadati yt-dlp."""
    dest.mkdir(parents=True, exist_ok=True)

    def hook(d: dict) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                on_progress(min(d.get("downloaded_bytes", 0) / total, 1.0))

    opts = _base_opts() | {
        # H.264 + AAC in MP4: riproducibile ovunque (WebView2, browser dei telefoni).
        "format": (
            "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/"
            "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/"
            "b[ext=mp4]/bv*[height<=1080]+ba/b"
        ),
        "merge_output_format": "mp4",
        "outtmpl": str(dest / "video.%(ext)s"),
        "progress_hooks": [hook],
        "noplaylist": True,
        "overwrites": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    video = dest / "video.mp4"
    if not video.exists():
        # Formato diverso da mp4 (raro): rinomina il file prodotto.
        candidates = [p for p in dest.glob("video.*") if p.suffix not in (".part", ".ytdl")]
        if not candidates:
            raise RuntimeError("Download fallito: file video non trovato")
        candidates[0].replace(video)
    return info
