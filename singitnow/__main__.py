"""Avvio di SingITnow.

    python -m singitnow            # finestra desktop (WebView2)
    python -m singitnow --browser  # apre l'interfaccia nel browser predefinito
    python -m singitnow --server   # solo server (es. sviluppo frontend con Vite)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

import uvicorn

from . import APP_NAME, config


def _serve() -> uvicorn.Server:
    server = uvicorn.Server(
        uvicorn.Config("singitnow.app:app", host=config.HOST, port=config.PORT, log_level="warning")
    )
    threading.Thread(target=server.run, name="uvicorn", daemon=True).start()
    url = f"http://127.0.0.1:{config.PORT}/api/info"
    for _ in range(100):
        try:
            urllib.request.urlopen(url, timeout=1)
            break
        except OSError:
            time.sleep(0.1)
    return server


def _allow_microphone() -> None:
    """WebView2 chiederebbe il permesso del microfono a ogni avvio: per l'app locale lo concediamo."""
    try:
        from webview.platforms import edgechromium
        from Microsoft.Web.WebView2.Core import CoreWebView2PermissionKind, CoreWebView2PermissionState
    except Exception:
        return
    original = edgechromium.EdgeChrome.on_webview_ready

    def on_ready(self, sender, args):
        original(self, sender, args)
        if not args.IsSuccess:
            return

        def on_permission(_sender, e):
            local = str(e.Uri).startswith(("http://127.0.0.1", "http://localhost"))
            if local and e.PermissionKind == CoreWebView2PermissionKind.Microphone:
                e.State = CoreWebView2PermissionState.Allow

        sender.CoreWebView2.PermissionRequested += on_permission

    edgechromium.EdgeChrome.on_webview_ready = on_ready


class JsApi:
    """Funzioni native esposte all'interfaccia (window.pywebview.api)."""

    def __init__(self) -> None:
        self._window = None  # privato: pywebview non deve esplorarlo
        self._fullscreen = False

    def toggle_fullscreen(self) -> None:
        if self._window:
            self._window.toggle_fullscreen()
            self._fullscreen = not self._fullscreen
            if not self._fullscreen:
                self._window.maximize()  # uscendo dallo schermo intero si torna massimizzati

    def set_fullscreen(self, on: bool) -> None:
        if bool(on) != self._fullscreen:
            self.toggle_fullscreen()

    def open_url(self, url: str) -> None:
        """Apre un link esterno (es. il video di YouTube da controllare) nel browser di Windows."""
        if isinstance(url, str) and url.startswith(("https://", "http://")):
            webbrowser.open(url)


def main() -> None:
    parser = argparse.ArgumentParser(prog="singitnow")
    parser.add_argument("--browser", action="store_true", help="usa il browser invece della finestra nativa")
    parser.add_argument("--server", action="store_true", help="avvia solo il server")
    args = parser.parse_args()

    config.ensure_dirs()
    if sys.stdout is None or sys.stderr is None:
        # Avvio senza console (pythonw): tutto l'output va nel file di log.
        log_file = open(config.DATA_DIR / "singitnow.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log_file
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    if args.server:
        print(f"{APP_NAME} in ascolto su http://127.0.0.1:{config.PORT}  (telefoni: http://{config.lan_ip()}:{config.PORT}/remote)")
        uvicorn.run("singitnow.app:app", host=config.HOST, port=config.PORT, log_level="info")
        return

    server = _serve()
    url = f"http://127.0.0.1:{config.PORT}/"
    print(f"{APP_NAME} avviato. Telefoni: http://{config.lan_ip()}:{config.PORT}/remote")

    if args.browser:
        webbrowser.open(url)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    else:
        import os

        import webview

        # Browser integrato (WebView2): l'audio parte anche se il brano viene avviato dal telefono
        # senza un clic sulla finestra, e la pagina non viene rallentata se la finestra è in
        # secondo piano o ridotta a icona (altrimenti la coda potrebbe non avanzare).
        os.environ.setdefault(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-features=ElasticOverscroll --autoplay-policy=no-user-gesture-required"
            " --disable-background-timer-throttling --disable-renderer-backgrounding"
            " --disable-backgrounding-occluded-windows",
        )

        _allow_microphone()
        # barra delle applicazioni: SingITnow col suo logo, non raggruppato sotto l'icona di Python
        try:
            import ctypes

            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("SingITnow.App")
        except (AttributeError, OSError):
            pass
        api = JsApi()
        api._window = webview.create_window(
            APP_NAME,
            url,
            width=1360,  # dimensioni usate quando l'utente "ripristina" la finestra
            height=860,
            min_size=(1024, 680),
            maximized=True,  # uscendo dallo schermo intero (Esc) la finestra resta a tutto lo schermo
            background_color="#0b0b14",
            js_api=api,
        )
        # si apre a schermo intero (Esc per uscire, F o F11 per rientrare). Va fatto a finestra già
        # visibile: con fullscreen=True di pywebview la massimizzazione lo annulla.
        api._window.events.shown += lambda: api.set_fullscreen(True)
        # chiusura con brani in importazione: si chiede conferma (False = la finestra resta aperta)
        api._window.events.closing += lambda: _confirm_close(api._window)
        icon = Path(__file__).with_name("icon.ico")  # il logo (il microfono accanto alla scritta SingITnow)
        webview.start(gui="edgechromium", private_mode=False, icon=str(icon) if icon.exists() else None)
        _discard_importing()  # prima di spegnere il server: i telefoni vedono sparire quei brani
    _shutdown(server)


def _importing() -> list:
    """Brani che si stanno ancora preparando (scaricamento, separazione, testo)."""
    from .library import ERROR, READY, library

    return [s for s in library.all() if s.status not in (READY, ERROR)]


_discard_on_exit: list[str] = []  # brani da cancellare: chiusura confermata durante l'importazione


def _discard_importing() -> None:
    """Chiusura confermata: dei brani in importazione non deve restare niente (file, coda, prenotazioni)."""
    from .library import library
    from .playlist import playlist

    if not _discard_on_exit:
        return
    library.mark_discarded(_discard_on_exit)  # i file ancora aperti spariranno al prossimo avvio
    for sid in _discard_on_exit:
        try:
            playlist.forget_song(sid)
            library.discard(sid)
        except Exception:
            logging.exception("Cancellazione del brano %s non riuscita", sid)


def importing_message(titles: list[str]) -> str:
    n = len(titles)
    which = f"del brano «{titles[0]}»" if n == 1 else f"di {n} brani ({', '.join(f'«{t}»' for t in titles[:3])}{'…' if n > 3 else ''})"
    return (
        f"È in corso l'importazione {which}.\n\n"
        "Se chiudi SingITnow adesso l'importazione si interrompe e tutto ciò che è stato scaricato e "
        f"preparato finora per {'questo brano' if n == 1 else 'questi brani'} verrà cancellato "
        f"({'andrà importato' if n == 1 else 'andranno importati'} di nuovo).\n\n"
        "Vuoi chiudere comunque?"
    )


def _confirm_close(window) -> bool:
    """True = si può chiudere. Con brani in importazione chiede conferma con un avviso di Windows."""
    try:
        songs = _importing()
    except Exception:
        return True
    if not songs:
        return True
    titles = [s.title or s.id for s in songs]
    try:
        import ctypes

        try:
            owner = int(window.native.Handle.ToInt64())  # avviso legato alla finestra (resta davanti)
        except Exception:
            owner = 0
        MB_YESNO, MB_ICONWARNING, MB_DEFBUTTON2, MB_SETFOREGROUND, MB_TOPMOST = 0x4, 0x30, 0x100, 0x10000, 0x40000
        IDYES = 6
        answer = ctypes.windll.user32.MessageBoxW(
            owner,
            importing_message(titles),
            f"{APP_NAME} - importazione in corso",
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND | MB_TOPMOST,
        )
        if answer != IDYES:
            return False
        _discard_on_exit[:] = [s.id for s in songs]
        return True
    except Exception:
        return True


def _shutdown(server: uvicorn.Server) -> None:
    """App chiusa: il brano in corso si ferma e i telefoni lo sanno subito (Live e Testo si fermano)."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{config.PORT}/api/player/stop", method="POST")
        urllib.request.urlopen(req, timeout=2)
        time.sleep(0.3)  # tempo per recapitare l'avviso ai telefoni
    except OSError:
        pass
    server.should_exit = True
    # chiusura ordinata: le connessioni con i telefoni vengono chiuse, non lasciate a metà
    for t in threading.enumerate():
        if t.name == "uvicorn":
            t.join(timeout=3)
    # il motore voce gira in un processo a parte: va fermato esplicitamente (lascerebbe occupate le casse)
    try:
        from .voice import voice

        voice.shutdown()
    except Exception:
        logging.exception("Arresto del motore voce")
    logging.shutdown()
    # Fine certa del processo: altrimenti qualche attività in background (code verso il motore voce,
    # thread di librerie) può tenerlo vivo all'infinito dopo la chiusura della finestra, con più copie
    # dell'app che si contendono microfoni e casse.
    os._exit(0)


if __name__ == "__main__":
    main()
