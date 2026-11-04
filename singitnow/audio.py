"""Estrazione audio e separazione voce / base musicale."""

from __future__ import annotations

import logging
import subprocess
import threading
from pathlib import Path

from . import config

log = logging.getLogger(__name__)

_separator = None
_separator_lock = threading.Lock()

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def ffmpeg(*args: str) -> None:
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args]
    result = subprocess.run(cmd, capture_output=True, text=True, creationflags=_NO_WINDOW)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg: {result.stderr.strip()[-500:]}")


def extract_wav(video: Path, out: Path) -> Path:
    ffmpeg("-i", str(video), "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", str(out))
    return out


def to_m4a(src: Path, out: Path) -> Path:
    ffmpeg("-i", str(src), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out))
    return out


def _get_separator(output_dir: Path):
    global _separator
    from audio_separator.separator import Separator

    if _separator is None:
        sep = Separator(
            model_file_dir=str(config.MODELS_DIR / "separation"),
            output_dir=str(output_dir),
            output_format="WAV",
            log_level=logging.WARNING,
        )
        sep.load_model(model_filename=config.SEPARATION_MODEL)
        _separator = sep
    # Il modello resta caricato: cambiamo solo la cartella di output per ogni brano.
    _separator.output_dir = str(output_dir)
    if getattr(_separator, "model_instance", None) is not None:
        _separator.model_instance.output_dir = str(output_dir)
    return _separator


def separate(wav: Path, work_dir: Path) -> tuple[Path, Path]:
    """Restituisce (vocals.wav, instrumental.wav)."""
    with _separator_lock:
        sep = _get_separator(work_dir)
        outputs = sep.separate(
            str(wav),
            custom_output_names={"Vocals": "vocals", "Instrumental": "instrumental"},
        )
    paths = [Path(p) if Path(p).is_absolute() else work_dir / p for p in outputs]
    vocals = next((p for p in paths if p.stem.lower() == "vocals"), work_dir / "vocals.wav")
    inst = next((p for p in paths if p.stem.lower() == "instrumental"), work_dir / "instrumental.wav")
    if not vocals.exists() or not inst.exists():
        raise RuntimeError(f"Separazione fallita, output: {outputs}")
    return vocals, inst
