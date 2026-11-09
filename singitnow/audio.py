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


_gpu_failed = False  # la GPU ha dato errore una volta: da lì in poi si resta sulla CPU


def gpu_provider() -> str | None:
    """Provider ONNX della scheda video (DirectML), se disponibile e non disattivato."""
    if not config.USE_GPU or _gpu_failed:
        return None
    try:
        import onnxruntime as ort
    except ImportError:
        return None
    return "DmlExecutionProvider" if "DmlExecutionProvider" in ort.get_available_providers() else None


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
        # audio-separator attiva DirectML solo insieme a torch-directml, che non segue le
        # versioni recenti di PyTorch. Basta però la sessione ONNX sulla GPU (la parte pesante):
        # la STFT resta in PyTorch su CPU, che costa poco.
        gpu = gpu_provider()
        if gpu:
            sep.onnx_execution_provider = [gpu, "CPUExecutionProvider"]
        sep.load_model(model_filename=config.SEPARATION_MODEL)
        log.info("Separazione voce su %s", "GPU (DirectML)" if gpu else "CPU")
        _separator = sep
    # Il modello resta caricato: cambiamo solo la cartella di output per ogni brano.
    _separator.output_dir = str(output_dir)
    if getattr(_separator, "model_instance", None) is not None:
        _separator.model_instance.output_dir = str(output_dir)
    return _separator


def separate(wav: Path, work_dir: Path) -> tuple[Path, Path]:
    """Restituisce (vocals.wav, instrumental.wav)."""
    global _separator, _gpu_failed
    names = {"Vocals": "vocals", "Instrumental": "instrumental"}
    with _separator_lock:
        sep = _get_separator(work_dir)
        try:
            outputs = sep.separate(str(wav), custom_output_names=names)
        except Exception:
            if sep.onnx_execution_provider[0] == "CPUExecutionProvider":
                raise
            # Driver o memoria della GPU: si ripete sulla CPU e non si riprova più la GPU.
            log.exception("Separazione sulla GPU fallita, riprovo sulla CPU")
            _gpu_failed = True
            _separator = None
            outputs = _get_separator(work_dir).separate(str(wav), custom_output_names=names)
    paths = [Path(p) if Path(p).is_absolute() else work_dir / p for p in outputs]
    vocals = next((p for p in paths if p.stem.lower() == "vocals"), work_dir / "vocals.wav")
    inst = next((p for p in paths if p.stem.lower() == "instrumental"), work_dir / "instrumental.wav")
    if not vocals.exists() or not inst.exists():
        raise RuntimeError(f"Separazione fallita, output: {outputs}")
    return vocals, inst


# ------------------------------------------------------------------ cambio di tonalità
KEY_RANGE = 6  # semitoni massimi verso l'alto o verso il basso
_key_locks: dict[Path, threading.Lock] = {}
_key_locks_guard = threading.Lock()
_has_rubberband: bool | None = None


def _rubberband() -> bool:
    """L'ffmpeg installato ha il filtro rubberband (tonalità di qualità, tempo invariato)?"""
    global _has_rubberband
    if _has_rubberband is None:
        try:
            out = subprocess.run(
                ["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True, creationflags=_NO_WINDOW
            ).stdout
            _has_rubberband = " rubberband " in out
        except OSError:
            _has_rubberband = False
    return _has_rubberband


def transposed(src: Path, semitones: int, voice: bool = False) -> Path:
    """
    Copia di `src` alzata o abbassata di `semitones` semitoni, alla stessa velocità
    (resta a tempo con video, testo e note). Viene creata la prima volta e poi riusata.
    Per la voce si conservano le formanti, così non suona «da cartone animato».
    """
    if semitones == 0:
        return src
    out = src.parent / "keys" / f"{src.stem}{semitones:+d}.m4a"
    with _key_locks_guard:
        lock = _key_locks.setdefault(out, threading.Lock())
    with lock:  # due richieste uguali insieme: la seconda aspetta e riusa il file
        if out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
            return out
        out.parent.mkdir(exist_ok=True)
        ratio = 2 ** (semitones / 12)
        if _rubberband():
            af = f"rubberband=pitch={ratio:.6f}:pitchq=quality" + (":formant=preserved" if voice else "")
        else:  # ffmpeg senza rubberband: cambio di velocità di campionamento + ritorno al tempo originale
            af = f"asetrate=44100*{ratio:.6f},aresample=44100,atempo={1 / ratio:.6f}"
        tmp = out.with_suffix(".tmp.m4a")
        log.info("Tonalità %+d: %s", semitones, src)
        ffmpeg("-i", str(src), "-af", af, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(tmp))
        tmp.replace(out)
        return out
