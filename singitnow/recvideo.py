"""Video verticale (9:16) di un'esibizione registrata, da condividere nelle storie.

Niente telecamera: lo sfondo (copertina, titolo, chi canta, punteggio, logo) è un'immagine fatta con
Pillow, sopra scorre il testo karaoke che si colora parola per parola (sottotitoli ASS disegnati da
ffmpeg/libass) e sotto c'è l'audio della registrazione (voce + base).

Due formati: «story» (un pezzo di STORY_SECONDS secondi, scelto dove il testo si ripete di più: di
solito il ritornello) e «full» (tutta l'esibizione). I tempi del testo sono quelli del brano: la
registrazione ne annota la corrispondenza (`marks`: coppie [secondi della registrazione, secondi del
brano] all'avvio e dopo ogni salto), così il testo resta a tempo anche se si è saltato avanti.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import threading
from pathlib import Path

from . import config

log = logging.getLogger(__name__)

W, H = 1080, 1920
FPS = 30
STORY_SECONDS = 60.0
KINDS = ("story", "full")
FONTS = Path(__file__).with_name("static") / "fonts"

# come sulla TV (vedi frontend/src/shared/lyrics.ts)
LEAD, HOLD, MAX_LATE = 0.9, 0.15, 0.35

BG = (11, 11, 20)
PINK, VIOLET, CYAN = (255, 61, 154), (139, 92, 246), (34, 211, 238)

_render_lock = threading.Lock()  # un video alla volta: il PC sta anche facendo cantare la serata
_state: dict[tuple[str, str], str] = {}  # (rid, kind) -> "working" | "error"
_state_lock = threading.Lock()


# ------------------------------------------------------------------ tempi
def song_to_rec(lines: list[dict], marks: list[list[float]], rec_seconds: float) -> list[dict]:
    """Righe del testo con i tempi della registrazione. `marks` = [[rec, brano], ...] in ordine di
    registrazione: da ogni segno la registrazione e il brano avanzano insieme fino al segno dopo.
    Le parole cantate fuori dai pezzi registrati si tolgono; una riga cantata due volte (si è tornati
    indietro) compare due volte."""
    marks = sorted(([float(r), float(s)] for r, s in marks or [[0.0, 0.0]]), key=lambda m: m[0]) or [[0.0, 0.0]]
    out = []
    for k, (r0, s0) in enumerate(marks):
        r1 = marks[k + 1][0] if k + 1 < len(marks) else rec_seconds
        s1 = s0 + (r1 - r0)
        if r1 <= r0:
            continue
        for line in lines:
            words = [
                {**w, "s": w["s"] - s0 + r0, "e": min(w["e"], s1) - s0 + r0}
                for w in line.get("words") or []
                if s0 <= w["s"] < s1
            ]
            if words:
                out.append({"text": line.get("text", ""), "words": words, "start": words[0]["s"], "end": words[-1]["e"]})
    out.sort(key=lambda l: l["start"])
    return out


def switch_times(lines: list[dict]) -> list[float]:
    """Istante in cui ogni riga diventa quella attiva (come switchTimes del frontend)."""
    out = []
    for i, line in enumerate(lines):
        early = line["start"] - LEAD
        if i == 0:
            out.append(early)
        else:
            prev = lines[i - 1]
            out.append(max(early, min(prev["end"] + HOLD, line["start"] + MAX_LATE)))
    return out


def _norm(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", text.casefold()).split())


def story_window(lines: list[dict], rec_seconds: float, length: float = STORY_SECONDS) -> tuple[float, float]:
    """Il pezzo da mettere nella storia: dove il testo si ripete di più (il ritornello), con una
    preferenza per i tratti pieni di parole. Tempi della registrazione."""
    if rec_seconds <= length or not lines:
        return 0.0, min(rec_seconds, length)
    count: dict[str, int] = {}
    for line in lines:
        k = _norm(line["text"])
        if k:
            count[k] = count.get(k, 0) + 1
    best, best_score = 0.0, -1.0
    for line in lines:
        a = max(0.0, min(line["start"] - 1.5, rec_seconds - length))
        b = a + length
        inside = [l for l in lines if l["start"] >= a and l["end"] <= b]
        score = sum(count.get(_norm(l["text"]), 1) - 1 for l in inside) + 0.25 * len(inside)
        if score > best_score + 1e-6:
            best, best_score = a, score
    return best, best + length


# ------------------------------------------------------------------ sottotitoli karaoke (ASS)
def _ass_time(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _ass_text(text: str) -> str:
    return text.replace("\\", "").replace("{", "(").replace("}", ")")


def _karaoke(line: dict, shown_at: float) -> str:
    """Riga con i tag \\kf: ogni parola si colora (da bianco a rosa) mentre viene cantata."""
    parts, t = [], shown_at
    for w in line["words"]:
        gap = w["s"] - t
        if gap > 0.005:
            parts.append(f"{{\\k{round(gap * 100)}}}")
            t = w["s"]
        dur = max(w["e"] - max(w["s"], t), 0.05)
        parts.append(f"{{\\kf{round(dur * 100)}}}{_ass_text(w['t'])} ")
        t = max(t, w["s"]) + dur
    return "".join(parts).rstrip()


def build_ass(lines: list[dict], a: float, b: float) -> str:
    """Sottotitoli del pezzo [a, b] della registrazione (tempi del video: da 0)."""
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cur,Outfit,84,&H009A3DFF,&H00FFFFFF,&H00140B0B,&H90000000,-1,0,0,0,100,100,0,0,1,4,3,8,70,70,0,1
Style: Next,Outfit,56,&H50FFFFFF,&H50FFFFFF,&H00140B0B,&H90000000,-1,0,0,0,100,100,0,0,1,3,2,8,90,90,0,1
Style: Wait,Outfit,44,&H40FFFFFF,&H40FFFFFF,&H00140B0B,&H00000000,0,0,0,0,100,100,0,0,1,0,0,8,90,90,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev = []
    times = switch_times(lines)
    cur_y, next_y = 1270, 1560
    for i, line in enumerate(lines):
        on = times[i]
        off = times[i + 1] if i + 1 < len(lines) else line["end"] + 2.0
        nxt = lines[i + 1] if i + 1 < len(lines) else None
        # pausa lunga (strumentale): la riga cantata sparisce, la prossima aspetta in piccolo
        if nxt and nxt["start"] - (line["end"] + 1.5) > 3:
            off = line["end"] + 1.5
        lo, hi = max(on, a), min(off, b)
        if hi - lo < 0.05:
            continue
        ev.append(f"Dialogue: 1,{_ass_time(lo - a)},{_ass_time(hi - a)},Cur,,0,0,0,,"
                  f"{{\\pos({W // 2},{cur_y})}}{_karaoke(line, lo)}")
        if nxt:
            ev.append(f"Dialogue: 0,{_ass_time(lo - a)},{_ass_time(hi - a)},Next,,0,0,0,,"
                      f"{{\\pos({W // 2},{next_y})}}{_ass_text(nxt['text'])}")
            if off < times[i + 1]:  # pausa: la prossima riga si vede già, in attesa
                g0, g1 = max(off, a), min(times[i + 1], b)
                if g1 - g0 > 0.05:
                    ev.append(f"Dialogue: 0,{_ass_time(g0 - a)},{_ass_time(g1 - a)},Next,,0,0,0,,"
                              f"{{\\pos({W // 2},{cur_y + 40})}}{_ass_text(nxt['text'])}")
    # prima riga ancora lontana (intro): si mostra già in attesa
    if lines and times[0] > a + 0.3:
        g1 = min(times[0], b)
        ev.insert(0, f"Dialogue: 0,{_ass_time(0)},{_ass_time(g1 - a)},Next,,0,0,0,,"
                     f"{{\\pos({W // 2},{cur_y + 40})}}{_ass_text(lines[0]['text'])}")
    return head + "\n".join(ev) + "\n"


# ------------------------------------------------------------------ sfondo (Pillow)
def _font(weight: str, size: int):
    from PIL import ImageFont

    return ImageFont.truetype(str(FONTS / f"Outfit-{weight}.ttf"), size)


def _gradient(size: tuple[int, int], colors=(PINK, VIOLET, CYAN)):
    """Gradiente orizzontale rosa → viola → azzurro (come --grad dell'app)."""
    from PIL import Image

    w, h = size
    img = Image.new("RGB", (w, 1))
    for x in range(w):
        p = x / max(w - 1, 1)
        a, b, q = (colors[0], colors[1], p / 0.55) if p < 0.55 else (colors[1], colors[2], (p - 0.55) / 0.45)
        img.putpixel((x, 0), tuple(round(a[c] + (b[c] - a[c]) * q) for c in range(3)))
    return img.resize((w, h))


def _fit(draw, text: str, weight: str, size: int, max_w: int):
    """Font che fa stare `text` in `max_w` (rimpicciolisce, poi taglia con «…»)."""
    while size > 26:
        f = _font(weight, size)
        if draw.textlength(text, font=f) <= max_w:
            return text, f
        size -= 2
    f = _font(weight, size)
    while text and draw.textlength(text + "…", font=f) > max_w:
        text = text[:-1]
    return text.rstrip() + "…", f


def _mic_logo(height: int):
    """Il microfono del logo (capsula, archetto, asta e base), in un'immagine trasparente."""
    from PIL import Image, ImageDraw

    s = height / 64 * 4  # disegnato 4 volte più grande e poi ridotto: bordi lisci
    big = Image.new("L", (round(64 * s), round(64 * s)), 0)
    d = ImageDraw.Draw(big)
    sw = round(4 * s)
    d.rounded_rectangle([24 * s, 10 * s, 40 * s, 38 * s], radius=8 * s, fill=255)
    d.arc([17 * s, 15 * s, 47 * s, 45 * s], 0, 180, fill=255, width=sw)
    d.line([32 * s, 45 * s, 32 * s, 54 * s], fill=255, width=sw)
    d.line([24 * s, 54 * s, 40 * s, 54 * s], fill=255, width=sw)
    for x, y in ((17, 30), (47, 30), (32, 54), (24, 54), (40, 54)):
        d.ellipse([(x - 2) * s, (y - 2) * s, (x + 2) * s, (y + 2) * s], fill=255)
    mask = big.resize((height, height), Image.LANCZOS)
    logo = _gradient((height, height)).convert("RGBA")
    logo.putalpha(mask)
    return logo


def _round(img, radius: int):
    from PIL import Image, ImageDraw

    mask = Image.new("L", (img.width * 3, img.height * 3), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, mask.width - 1, mask.height - 1], radius=radius * 3, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask.resize(img.size, Image.LANCZOS))
    return out


def _circle(img, size: int):
    from PIL import Image, ImageDraw, ImageOps

    img = ImageOps.fit(img.convert("RGB"), (size, size), Image.LANCZOS)
    mask = Image.new("L", (size * 3, size * 3), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size * 3 - 1, size * 3 - 1], fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask.resize((size, size), Image.LANCZOS))
    return out


def background(out: Path, title: str, artist: str, names: list[str], cover: Path | None,
               photos: list[Path | None], score: int | None) -> None:
    from PIL import Image, ImageDraw, ImageFilter, ImageOps

    img = Image.new("RGB", (W, H), BG)
    # luci colorate sfocate (come l'animazione di avvio)
    glow = Image.new("RGB", (W // 8, H // 8), BG)
    g = ImageDraw.Draw(glow)
    g.ellipse([-40, -50, 90, 80], fill=(120, 30, 85))
    g.ellipse([70, 150, 200, 290], fill=(15, 95, 110))
    g.ellipse([20, 80, 120, 170], fill=(60, 40, 120))
    glow = glow.filter(ImageFilter.GaussianBlur(28)).resize((W, H), Image.BICUBIC)
    img = Image.blend(img, glow, 0.85)

    if cover and cover.exists():
        try:
            c = Image.open(cover).convert("RGB")
            # la copertina, sfocata, colora la parte alta dello sfondo
            haze = ImageOps.fit(c, (W // 10, H // 20)).filter(ImageFilter.GaussianBlur(6)).resize((W, H // 2), Image.BICUBIC)
            fade = Image.linear_gradient("L").resize((W, H // 2)).point(lambda v: int((255 - v) * 0.45))
            img.paste(haze, (0, 0), fade)
            art = _round(ImageOps.fit(c, (560, 560), Image.LANCZOS), 40)
            shadow = Image.new("RGBA", (760, 760), (0, 0, 0, 0))
            ImageDraw.Draw(shadow).rounded_rectangle([100, 110, 660, 670], radius=40, fill=(0, 0, 0, 170))
            shadow = shadow.filter(ImageFilter.GaussianBlur(30))
            img.paste(shadow, (W // 2 - 380, 170), shadow)
            img.paste(art, (W // 2 - 280, 270), art)
        except OSError:
            log.warning("Copertina non leggibile: %s", cover)

    d = ImageDraw.Draw(img)
    # logo in alto
    mic = _mic_logo(70)
    name_f = _font("Bold", 58)
    parts = [("Sing", None), ("IT", "grad"), ("now", None)]
    total = mic.width + 14 + sum(d.textlength(t, font=name_f) for t, _ in parts)
    x = (W - total) / 2
    img.paste(mic, (round(x), 78), mic)
    x += mic.width + 14
    for t, style in parts:
        tw = round(d.textlength(t, font=name_f))
        if style == "grad":
            m = Image.new("L", (tw + 4, 80), 0)
            ImageDraw.Draw(m).text((0, 0), t, font=name_f, fill=255)
            gr = _gradient((tw + 4, 80)).convert("RGBA")
            gr.putalpha(m)
            img.paste(gr, (round(x), 82), gr)
        else:
            d.text((x, 82), t, font=name_f, fill=(244, 243, 255))
        x += tw

    # titolo e artista sotto la copertina
    t_text, t_font = _fit(d, title, "Bold", 62, W - 140)
    d.text((W / 2, 880), t_text, font=t_font, fill=(244, 243, 255), anchor="mm")
    if artist:
        a_text, a_font = _fit(d, artist, "Regular", 40, W - 160)
        d.text((W / 2, 942), a_text, font=a_font, fill=(180, 178, 204), anchor="mm")

    # chi canta: foto (o iniziale) e nome, poi il punteggio
    size = 92
    who = " e ".join(names) if names else ""
    label_f = _font("Regular", 34)
    n_text, n_font = _fit(d, who, "SemiBold", 50, W - 200 - size * len(names))
    row_w = len(names) * (size - 18) + 18 + 24 + d.textlength(n_text, font=n_font)
    x0 = (W - row_w) / 2
    y0 = 1000
    for k, nm in enumerate(names):
        px = round(x0 + k * (size - 18))
        ring = _circle(_gradient((size + 8, size + 8)), size + 8)
        img.paste(ring, (px - 4, y0 - 4), ring)
        photo = photos[k] if k < len(photos) else None
        try:
            face = _circle(Image.open(photo), size) if photo else None
        except OSError:
            face = None
        if face is None:
            face = _circle(Image.new("RGB", (size, size), (40, 36, 70)), size)
            ImageDraw.Draw(face).text((size / 2, size / 2), (nm[:1] or "?").upper(), font=_font("Bold", 46),
                                      fill=(244, 243, 255), anchor="mm")
        img.paste(face, (px, y0), face)
    tx = x0 + len(names) * (size - 18) + 18 + 24
    d.text((tx, y0 + 8), "canta" if len(names) < 2 else "cantano", font=label_f, fill=(180, 178, 204))
    d.text((tx, y0 + 40), n_text, font=n_font, fill=(244, 243, 255))
    if score is not None:
        badge_f = _font("Bold", 40)
        text = f"{score} punti"
        bw = round(d.textlength(text, font=badge_f)) + 64
        bx, by = (W - bw) // 2, 1118
        pill = _round(_gradient((bw, 62)), 31)
        img.paste(pill, (bx, by), pill)
        d.text((W / 2, by + 31), text, font=badge_f, fill=(255, 255, 255), anchor="mm")

    # zona del testo: un velo scuro per leggerlo bene
    veil = Image.new("RGBA", (W - 80, 560), (0, 0, 0, 0))
    ImageDraw.Draw(veil).rounded_rectangle([0, 0, W - 81, 559], radius=44, fill=(8, 8, 16, 150))
    img.paste(veil, (40, 1195), veil)

    foot_f = _font("SemiBold", 30)
    d.text((W / 2, 1838), "K A R A O K E   P A R T Y", font=foot_f, fill=(150, 148, 175), anchor="mm")
    img.save(out)


# ------------------------------------------------------------------ montaggio
def render(rid: str, kind: str) -> Path:
    """Crea (o riusa) il video `kind` della registrazione `rid`. Restituisce il file MP4."""
    from . import avatars, halloffame, recordings
    from .library import library

    if kind not in KINDS:
        raise ValueError("Formato non valido")
    d = recordings.folder(rid)
    out = d / f"video-{kind}.mp4"
    if out.exists():
        return out
    meta = recordings.meta(rid) or {}
    audio_file = d / "rec.m4a"
    if not audio_file.exists():
        raise RuntimeError("La registrazione è ancora in preparazione")
    rec_seconds = _duration(audio_file) or float(meta.get("seconds") or 0)

    song = library.get(meta.get("song_id", ""))
    lines: list[dict] = []
    if song:
        try:
            data = json.loads((song.dir / "lyrics.json").read_text(encoding="utf-8"))
            lines = [l for l in data.get("lines", []) if l.get("words")]
        except (OSError, ValueError):
            lines = []
    lines = song_to_rec(lines, meta.get("marks") or [[0.0, 0.0]], rec_seconds)
    a, b = story_window(lines, rec_seconds) if kind == "story" else (0.0, rec_seconds)
    b = min(b, rec_seconds)

    cover = None
    if song:
        cover = next((p for p in (song.dir / "cover.jpg", song.dir / "thumb.jpg") if p.exists()), None)
    names = meta.get("names") or []
    score = halloffame.score_for(meta.get("song_id", ""), meta.get("keys") or [], float(meta.get("t") or 0))

    tmp = d / f"video-{kind}.tmp"
    tmp.mkdir(exist_ok=True)
    try:
        background(tmp / "bg.png", meta.get("title", ""), meta.get("artist", ""), names, cover,
                   [avatars.path(n) for n in names], score)
        (tmp / "lyrics.ass").write_text(build_ass(lines, a, b), encoding="utf-8")
        dur = b - a
        fade = 1.5 if kind == "story" else 2.0
        fonts = str(FONTS).replace("\\", "/").replace(":", "\\:")
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-loop", "1", "-framerate", str(FPS), "-i", "bg.png",
            "-ss", f"{a:.3f}", "-t", f"{dur:.3f}", "-i", str(audio_file),
            "-filter_complex",
            f"[0:v]ass=lyrics.ass:fontsdir='{fonts}',fade=t=in:st=0:d=0.6,"
            f"fade=t=out:st={max(dur - 0.8, 0):.3f}:d=0.8,format=yuv420p[v];"
            f"[1:a]afade=t=in:st=0:d=0.8,afade=t=out:st={max(dur - fade, 0):.3f}:d={fade}[a]",
            "-map", "[v]", "-map", "[a]", "-t", f"{dur:.3f}",
            "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-crf", "23", "-r", str(FPS),
            "-threads", "4", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "out.mp4",
        ]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)
        res = subprocess.run(cmd, cwd=tmp, capture_output=True, text=True, creationflags=flags)
        if res.returncode != 0:
            raise RuntimeError(f"ffmpeg: {res.stderr.strip()[-400:]}")
        (tmp / "out.mp4").replace(out)
    finally:
        for p in tmp.glob("*"):
            p.unlink(missing_ok=True)
        tmp.rmdir()
    return out


def _duration(path: Path) -> float:
    try:
        res = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return float(res.stdout.strip())
    except (OSError, ValueError):
        return 0.0


def state(rid: str, kind: str) -> str:
    """"ready", "working", "error" o "" (non ancora chiesto)."""
    from . import recordings

    if (recordings.folder(rid) / f"video-{kind}.mp4").exists():
        return "ready"
    with _state_lock:
        return _state.get((rid, kind), "")


def start(rid: str, kind: str) -> str:
    """Avvia la creazione del video in background (se non c'è già). Restituisce lo stato."""
    s = state(rid, kind)
    if s in ("ready", "working"):
        return s
    with _state_lock:
        _state[(rid, kind)] = "working"

    def job():
        try:
            with _render_lock:
                render(rid, kind)
            with _state_lock:
                _state.pop((rid, kind), None)
        except Exception:
            log.exception("Video della registrazione %s (%s)", rid, kind)
            with _state_lock:
                _state[(rid, kind)] = "error"

    threading.Thread(target=job, name="video-registrazione", daemon=True).start()
    return "working"
