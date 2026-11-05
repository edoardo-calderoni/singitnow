"""Avvio di SingITnow.

    python -m singitnow            # finestra desktop (WebView2)
    python -m singitnow --browser  # apre l'interfaccia nel browser predefinito
    python -m singitnow --server   # solo server (es. sviluppo frontend con Vite)
"""

from __future__ import annotations

import argparse
import logging
import sys
import threading
import time
import urllib.request
import webbrowser

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

        api = JsApi()
        api._window = webview.create_window(
            APP_NAME,
            url,
            width=1360,  # dimensioni usate quando l'utente "ripristina" la finestra
            height=860,
            min_size=(1024, 680),
            maximized=True,  # si apre sempre a tutto lo schermo (barra del titolo visibile)
            background_color="#0b0b14",
            js_api=api,
        )
        webview.start(gui="edgechromium", private_mode=False)
    server.should_exit = True


if __name__ == "__main__":
    main()
