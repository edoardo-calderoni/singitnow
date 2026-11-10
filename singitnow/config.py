"""Configurazione centralizzata (percorsi, porta, modelli).

Tutti i valori possono essere sovrascritti con variabili d'ambiente SINGITNOW_*.
"""

from __future__ import annotations

import ipaddress
import os
import re
import socket
import subprocess
import sys
import time
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


_DEFAULT_ROUTE = re.compile(
    r"^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s*$", re.M
)
_lan_cache: tuple[float, str] = (0.0, "")


def _gateway_ip(route_table: str) -> str | None:
    """Dalla tabella di `route print -4`: l'IP del PC sull'interfaccia del gateway di casa (rotta
    predefinita con un gateway vero, la metrica più bassa). Le VPN (es. ESET, Tailscale) instradano
    tutto con rotte «On-link» senza gateway, e le schede virtuali (VMware, Hyper-V) non ne hanno:
    così non finiscono nel QR code, dove il telefono non le raggiungerebbe."""
    best = None
    for gw, ip, metric in _DEFAULT_ROUTE.findall(route_table):
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if not addr.is_private or addr.is_loopback or addr.is_link_local:
            continue
        if best is None or int(metric) < best[0]:
            best = (int(metric), ip)
    return best[1] if best else None


def lan_ip() -> str:
    """IP del PC sulla rete locale (quello che i telefoni useranno per collegarsi)."""
    global _lan_cache
    now = time.monotonic()
    if _lan_cache[1] and now - _lan_cache[0] < 30:
        return _lan_cache[1]
    ip = None
    if sys.platform == "win32":
        try:
            table = subprocess.run(
                ["route", "print", "-4"], capture_output=True, text=True, timeout=3,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            ).stdout
            ip = _gateway_ip(table)
        except (OSError, subprocess.SubprocessError):
            ip = None
    if not ip:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            # Nessun pacchetto viene inviato: serve solo a scegliere l'interfaccia di uscita.
            s.connect(("10.255.255.255", 1))
            ip = s.getsockname()[0]
        except OSError:
            ip = "127.0.0.1"
        finally:
            s.close()
    _lan_cache = (now, ip)
    return ip
