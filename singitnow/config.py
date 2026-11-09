"""Configurazione centralizzata (percorsi, porta, modelli).

Tutti i valori possono essere sovrascritti con variabili d'ambiente SINGITNOW_*.
"""

from __future__ import annotations

import os
import socket
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent

DATA_DIR = Path(os.environ.get("SINGITNOW_DATA", ROOT_DIR / "data")).resolve()
LIBRARY_DIR = DATA_DIR / "library"
MODELS_DIR = DATA_DIR / "models"
WORK_DIR = DATA_DIR / "work"

FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"

HOST = os.environ.get("SINGITNOW_HOST", "0.0.0.0")
PORT = int(os.environ.get("SINGITNOW_PORT", "8765"))

# Modello di separazione voce/musica (audio-separator). MDX-Net ONNX: buon compromesso
# qualità/velocità su CPU. Alternative: "UVR-MDX-NET-Voc_FT.onnx",
# "model_bs_roformer_ep_317_sdr_12.9755.ckpt" (migliore ma molto più lento su CPU).
SEPARATION_MODEL = os.environ.get("SINGITNOW_SEPARATION_MODEL", "UVR-MDX-NET-Inst_HQ_3.onnx")

# Scheda video per la separazione (DirectML: qualsiasi GPU su Windows, AMD/NVIDIA/Intel).
# "0" la disattiva e forza la CPU.
USE_GPU = os.environ.get("SINGITNOW_GPU", "1") != "0"

# Modello Whisper per allineamento parole / trascrizione (tiny, base, small, medium, large-v3).
WHISPER_MODEL = os.environ.get("SINGITNOW_WHISPER_MODEL", "small")

USER_AGENT = "SingITnow/0.1 (https://github.com/edoardo-calderoni/singitnow)"


def ensure_dirs() -> None:
    for d in (DATA_DIR, LIBRARY_DIR, MODELS_DIR, WORK_DIR):
        d.mkdir(parents=True, exist_ok=True)


def lan_ip() -> str:
    """IP del PC sulla rete locale (quello che i telefoni useranno per collegarsi)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Nessun pacchetto viene inviato: serve solo a scegliere l'interfaccia di uscita.
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()
