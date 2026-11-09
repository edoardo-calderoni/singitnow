"""Microfoni per cantare: volume e muto, regolati dall'app principale o dagli amministratori.

La voce arriva alle casse tramite Windows («Ascolta questo dispositivo» nelle proprietà del
microfono), non tramite SingITnow: per alzarla, abbassarla o silenziarla si regola il microfono
stesso in Windows (il livello di registrazione vale anche per l'ascolto).

I microfoni sono scelti come fa il player per l'intonazione: con due microfoni collegati, quello
predefinito di Windows e un secondo; altrimenti solo quello predefinito. Webcam, microfoni del
portatile e «Missaggio stereo» non contano.
"""

from __future__ import annotations

import concurrent.futures
import logging
import os
import re
import sys
import warnings

log = logging.getLogger(__name__)

# stessa regola di frontend/src/desktop/mic.ts
_NOT_FOR_SINGING = re.compile(
    r"webcam|camera|\bcam\b|array|matrice|integrat|built-?in|stereo mix|missaggio stereo|what u hear", re.I
)


def _init_com() -> None:
    import comtypes

    comtypes.CoInitialize()


# Le chiamate COM di Windows vanno fatte sempre dallo stesso thread (inizializzato per COM).
_worker = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="mics", initializer=_init_com)


def _run(fn, *args):
    return _worker.submit(fn, *args).result(timeout=10)


def _endpoints():
    """[(id, nome, IAudioEndpointVolume)] dei microfoni con cui si canta (al massimo due)."""
    import comtypes
    from pycaw.constants import CLSID_MMDeviceEnumerator, DEVICE_STATE, EDataFlow, ERole
    from pycaw.pycaw import AudioUtilities, IMMDeviceEnumerator

    enum = comtypes.CoCreateInstance(CLSID_MMDeviceEnumerator, IMMDeviceEnumerator, comtypes.CLSCTX_INPROC_SERVER)
    try:
        default_id = enum.GetDefaultAudioEndpoint(EDataFlow.eCapture.value, ERole.eMultimedia.value).GetId()
    except Exception:
        default_id = None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # pycaw avvisa per ogni proprietà del dispositivo che non riesce a leggere
        devices = AudioUtilities.GetAllDevices(
            data_flow=EDataFlow.eCapture.value, device_state=DEVICE_STATE.ACTIVE.value
        )
    real = [d for d in devices if d.FriendlyName and not _NOT_FOR_SINGING.search(d.FriendlyName)]
    if len(real) >= 2:
        real.sort(key=lambda d: d.id != default_id)  # il predefinito per primo
        chosen = real[:2]
    else:
        chosen = [d for d in devices if d.id == default_id][:1] or real[:1]
    return [(d.id, d.FriendlyName, d.EndpointVolume) for d in chosen]


def _list() -> list[dict]:
    out = []
    for i, (dev_id, name, vol) in enumerate(_endpoints()):
        out.append(
            {
                "index": i,
                "name": name,
                "volume": round(float(vol.GetMasterVolumeLevelScalar()), 3),
                "muted": bool(vol.GetMute()),
            }
        )
    return out


def _set(index: int, volume: float | None, muted: bool | None) -> list[dict]:
    eps = _endpoints()
    if not 0 <= index < len(eps):
        raise IndexError(index)
    vol = eps[index][2]
    if volume is not None:
        vol.SetMasterVolumeLevelScalar(max(0.0, min(1.0, float(volume))), None)
    if muted is not None:
        vol.SetMute(bool(muted), None)
    return _list()


def available() -> bool:
    return sys.platform == "win32"


# Solo per le prove senza microfoni veri: SINGITNOW_FAKE_MICS=2 simula due microfoni.
_FAKE = int(os.environ.get("SINGITNOW_FAKE_MICS", "0") or 0)
_fake = [{"index": i, "name": f"Microfono di prova {i + 1}", "volume": 0.8, "muted": False} for i in range(_FAKE)]


def list_mics() -> list[dict]:
    """Microfoni per cantare con volume (0..1) e muto. Vuota se non ce ne sono o fuori da Windows."""
    if _FAKE:
        return [dict(m) for m in _fake]
    if not available():
        return []
    try:
        return _run(_list)
    except Exception:
        log.exception("Lettura dei microfoni non riuscita")
        return []


def _listening() -> list[str]:
    """Nomi dei microfoni per cantare con «Ascolta questo dispositivo» attivo in Windows."""
    from ctypes import byref

    from comtypes import GUID
    from pycaw.api.mmdeviceapi.depend.structures import PROPERTYKEY
    from pycaw.constants import CLSID_MMDeviceEnumerator, DEVICE_STATE, EDataFlow
    from pycaw.pycaw import IMMDeviceEnumerator

    import comtypes

    wanted = {name for _, name, _ in _endpoints()}
    key = PROPERTYKEY(GUID("{24DBB0FC-9311-4B3D-9CF0-18FF155639D4}"), 1)  # «Ascolta questo dispositivo»
    enum = comtypes.CoCreateInstance(CLSID_MMDeviceEnumerator, IMMDeviceEnumerator, comtypes.CLSCTX_INPROC_SERVER)
    coll = enum.EnumAudioEndpoints(EDataFlow.eCapture.value, DEVICE_STATE.ACTIVE.value)
    out = []
    from pycaw.utils import AudioUtilities

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for i in range(coll.GetCount()):
            dev = coll.Item(i)
            name = AudioUtilities.CreateDevice(dev).FriendlyName or ""
            if name not in wanted:
                continue
            try:
                pv = dev.OpenPropertyStore(0).GetValue(byref(key))
                if pv.GetValue() is True:
                    out.append(name)
            except Exception:
                pass
    return out


def listening() -> list[str]:
    """Microfoni che Windows manda già alle casse («Ascolta questo dispositivo»): con la voce gestita
    da SingITnow si sentirebbero due volte."""
    if _FAKE or not available():
        return []
    try:
        return _run(_listening)
    except Exception:
        log.exception("Lettura di «Ascolta questo dispositivo» non riuscita")
        return []


def _any_active() -> bool:
    from pycaw.constants import DEVICE_STATE, EDataFlow
    from pycaw.pycaw import AudioUtilities

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return bool(
            AudioUtilities.GetAllDevices(data_flow=EDataFlow.eCapture.value, device_state=DEVICE_STATE.ACTIVE.value)
        )


def any_input() -> bool:
    """True se a Windows è collegato almeno un microfono (qualsiasi, come per l'intonazione)."""
    if _FAKE:
        return True
    if not available():
        return True  # fuori da Windows non si può sapere: non si blocca niente
    try:
        return _run(_any_active)
    except Exception:
        log.exception("Controllo dei microfoni non riuscito")
        return True


def set_mic(index: int, volume: float | None = None, muted: bool | None = None) -> list[dict]:
    if _FAKE:
        if not 0 <= index < len(_fake):
            raise IndexError(index)
        if volume is not None:
            _fake[index]["volume"] = round(max(0.0, min(1.0, float(volume))), 3)
        if muted is not None:
            _fake[index]["muted"] = bool(muted)
        return list_mics()
    if not available():
        raise RuntimeError("Regolazione dei microfoni disponibile solo su Windows")
    return _run(_set, index, volume, muted)



# uscite che passano da TV o monitor (HDMI/DisplayPort), o virtuali: la voce lì arriverebbe in ritardo
_NOT_SPEAKERS = re.compile(r"hdmi|displayport|display audio|high definition audio device|nvidia|oculus|virtual|^\d+ - ", re.I)
_SPEAKERS = re.compile(r"casse|altoparlant|speaker", re.I)


def _speakers() -> str:
    from pycaw.constants import DEVICE_STATE, EDataFlow
    from pycaw.pycaw import AudioUtilities

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        devices = AudioUtilities.GetAllDevices(data_flow=EDataFlow.eRender.value, device_state=DEVICE_STATE.ACTIVE.value)
    names = [d.FriendlyName for d in devices if d.FriendlyName and not _NOT_SPEAKERS.search(d.FriendlyName)]
    names.sort(key=lambda n: not _SPEAKERS.search(n))  # prima quelle che si chiamano «Casse»
    return names[0] if names else ""


def speakers() -> str | None:
    """Casse collegate al PC per la voce dei microfoni ("" = nessuna: si usa l'uscita predefinita;
    None = non si è riusciti a saperlo, si lascia la voce dov'è)."""
    if _FAKE or not available():
        return ""
    try:
        return _run(_speakers)
    except Exception:
        log.exception("Ricerca delle casse non riuscita")
        return None
