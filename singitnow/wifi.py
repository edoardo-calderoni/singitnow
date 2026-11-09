"""Rete Wi-Fi di casa per gli ospiti: un amministratore la imposta dal telefono e la TV ne mostra il QR code.

Il QR usa il formato standard «WIFI:T:WPA;S:<rete>;P:<password>;;», che la fotocamera di Android
e di iPhone riconosce proponendo di collegarsi senza digitare la password.

I dati restano solo sul PC (data/settings.json) e li vedono solo gli amministratori e la TV.
Se il PC è collegato in Wi-Fi, la rete attuale (nome e, quando Windows la concede, la password)
si può leggere dai profili salvati di Windows per non doverla scrivere a mano.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
import xml.etree.ElementTree as ET
from pathlib import Path

import segno

from . import config

SECURITY = ("WPA", "WEP", "nopass")  # WPA vale anche per WPA2 e WPA3
_lock = threading.Lock()


def _path() -> Path:
    return config.DATA_DIR / "settings.json"


def _read_all() -> dict:
    try:
        return json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def get() -> dict | None:
    """Rete salvata ({ssid, password, security, hidden}) o None."""
    w = _read_all().get("wifi")
    if not isinstance(w, dict) or not str(w.get("ssid") or "").strip():
        return None
    security = w.get("security") if w.get("security") in SECURITY else "WPA"
    return {
        "ssid": str(w["ssid"]),
        "password": "" if security == "nopass" else str(w.get("password") or ""),
        "security": security,
        "hidden": bool(w.get("hidden")),
    }


def save(ssid: str, password: str, security: str, hidden: bool) -> dict | None:
    """Salva la rete; con il nome vuoto la cancella."""
    ssid = ssid.strip()
    if security not in SECURITY:
        raise ValueError("Sicurezza sconosciuta")
    if ssid:
        if len(ssid.encode("utf-8")) > 32:
            raise ValueError("Il nome della rete è troppo lungo (massimo 32 caratteri)")
        if security == "WPA" and not 8 <= len(password) <= 63:
            raise ValueError("La password WPA deve avere fra 8 e 63 caratteri")
        if security == "WEP" and not password:
            raise ValueError("Manca la password")
    with _lock:
        data = _read_all()
        if ssid:
            data["wifi"] = {
                "ssid": ssid,
                "password": "" if security == "nopass" else password,
                "security": security,
                "hidden": hidden,
            }
        else:
            data.pop("wifi", None)
        _path().parent.mkdir(parents=True, exist_ok=True)
        _path().write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return get()


def _esc(s: str) -> str:
    """Caratteri speciali del formato WIFI: (\\ ; , : ") vanno preceduti da \\."""
    for ch in '\\;,:"':
        s = s.replace(ch, "\\" + ch)
    return s


def qr_text(w: dict) -> str:
    parts = [f"T:{w['security']}", f"S:{_esc(w['ssid'])}"]
    if w["security"] != "nopass":
        parts.append(f"P:{_esc(w['password'])}")
    if w.get("hidden"):
        parts.append("H:true")
    return "WIFI:" + ";".join(parts) + ";;"


def qr_svg(w: dict) -> str:
    qr = segno.make(qr_text(w), error="m")
    return qr.svg_inline(scale=6, dark="#0b0b14", light="#ffffff", border=2, omitsize=True)


# ------------------------------------------------------------------ rete attuale del PC (Windows)
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _netsh(*args: str) -> str:
    out = subprocess.run(
        ["netsh", "wlan", *args],
        capture_output=True,
        timeout=10,
        creationflags=_NO_WINDOW,
    )
    return out.stdout.decode("oem" if sys.platform == "win32" else "utf-8", errors="replace")


def _connected_ssids() -> list[str]:
    """Nomi delle reti a cui il PC è collegato adesso (la riga «SSID» non è tradotta da Windows)."""
    ssids = []
    for line in _netsh("show", "interfaces").splitlines():
        key, _, value = line.partition(":")
        if key.strip() == "SSID" and value.strip():
            ssids.append(value.strip())
    return ssids


def _profiles() -> list[dict]:
    """Profili Wi-Fi salvati in Windows, letti dall'esportazione XML (uguale in tutte le lingue)."""
    found = []
    with tempfile.TemporaryDirectory() as tmp:
        _netsh("export", "profile", "key=clear", f"folder={tmp}")
        ns = {"w": "http://www.microsoft.com/networking/WLAN/profile/v1"}
        for f in Path(tmp).glob("*.xml"):
            try:
                root = ET.parse(f).getroot()
            except ET.ParseError:
                continue
            name = root.findtext("w:SSIDConfig/w:SSID/w:name", default="", namespaces=ns)
            auth = root.findtext("w:MSM/w:security/w:authEncryption/w:authentication", default="", namespaces=ns)
            enc = root.findtext("w:MSM/w:security/w:authEncryption/w:encryption", default="", namespaces=ns)
            key = root.find("w:MSM/w:security/w:sharedKey", ns)
            protected = key is not None and key.findtext("w:protected", default="false", namespaces=ns) == "true"
            password = "" if key is None or protected else key.findtext("w:keyMaterial", default="", namespaces=ns)
            hidden = root.findtext("w:SSIDConfig/w:nonBroadcast", default="false", namespaces=ns) == "true"
            if auth.lower() == "open" and enc.lower() in ("none", ""):
                security = "nopass"
            elif enc.upper() == "WEP":
                security = "WEP"
            else:
                security = "WPA"
            found.append({"ssid": name, "password": password, "security": security, "hidden": hidden})
    return found


def detect() -> dict | None:
    """Rete Wi-Fi a cui è collegato il PC (password compresa se Windows la fornisce), o None."""
    if sys.platform != "win32":
        return None
    try:
        ssids = _connected_ssids()
        if not ssids:
            return None
        for p in _profiles():
            if p["ssid"] == ssids[0]:
                return p
        return {"ssid": ssids[0], "password": "", "security": "WPA", "hidden": False}
    except (OSError, subprocess.SubprocessError):
        return None
