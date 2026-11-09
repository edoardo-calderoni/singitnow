import { useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";

declare global {
  interface Window {
    /** presente quando la pagina gira dentro l'app Android di SingITnow */
    SingITnowApp?: {
      setVolumeKeys(on: boolean): void;
      version(): string;
      changeServer(): void;
      openUrl?(url: string): void;
      /** dalla versione 4: avviso «Tocca a te!» anche a schermo spento */
      setIdentity?(first: string, last: string): void;
      clearIdentity?(): void;
    };
  }
}

const HIDE_KEY = "sin.installHidden";

/**
 * Invito a installare SingITnow sul telefono:
 * Android → app da scaricare dal PC; iPhone → «Aggiungi alla schermata Home» (si apre senza bordi).
 * Non compare dentro l'app, né se la pagina è già aperta dalla schermata Home.
 */
export function InstallBanner() {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [apk, setApk] = useState(false);
  const ua = navigator.userAgent;
  const android = /Android/i.test(ua);
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const inApp = !!window.SingITnowApp;
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone;

  useEffect(() => {
    if (!android || inApp) return;
    fetch("/api/app")
      .then((r) => r.json())
      .then((d) => setApk(!!d.android))
      .catch(() => {});
  }, [android, inApp]);

  // app Android vecchia (senza l'avviso a schermo spento): si propone l'aggiornamento
  const oldApp = inApp && Number(window.SingITnowApp?.version() ?? 0) < 5;
  if (oldApp && !hidden)
    return (
      <div className="m-install">
        <button className="m-install-x" onClick={() => setHidden(true)} aria-label="Chiudi">
          <X size={16} />
        </button>
        <img src="/icon.svg" alt="" />
        <div className="m-install-body">
          <b>Aggiorna l'app SingITnow</b>
          <span>Con la nuova versione resti collegato anche a schermo spento e il telefono ti avvisa quando tocca a te.</span>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => window.SingITnowApp?.openUrl?.(`${location.origin}/download/SingITnow.apk`)}
          >
            <Download size={16} /> Scarica l'aggiornamento
          </button>
          <small>Apri il file scaricato e conferma l'installazione: resti nella festa con gli stessi dati.</small>
        </div>
      </div>
    );

  if (hidden || inApp || standalone) return null;
  const close = () => {
    setHidden(true);
    try {
      localStorage.setItem(HIDE_KEY, "1");
    } catch {
      /* niente memoria: ricomparirà la prossima volta */
    }
  };

  if (android && apk)
    return (
      <div className="m-install">
        <button className="m-install-x" onClick={close} aria-label="Chiudi">
          <X size={16} />
        </button>
        <img src="/icon.svg" alt="" />
        <div className="m-install-body">
          <b>Installa l'app SingITnow</b>
          <span>Si apre a tutto schermo, senza la barra del browser.</span>
          <a className="btn btn-primary btn-sm" href="/download/SingITnow.apk" download>
            <Download size={16} /> Scarica l'app
          </a>
          <small>
            Poi apri il file scaricato: Android chiede di consentire l'installazione da Chrome (solo la prima volta).
          </small>
        </div>
      </div>
    );

  if (ios)
    return (
      <div className="m-install">
        <button className="m-install-x" onClick={close} aria-label="Chiudi">
          <X size={16} />
        </button>
        <img src="/icon.svg" alt="" />
        <div className="m-install-body">
          <b>Aggiungi SingITnow alla Home</b>
          <span>
            Tocca <Share size={15} className="inline-icon" /> <b>Condividi</b> in Safari, poi{" "}
            <b>«Aggiungi alla schermata Home»</b>: si aprirà a tutto schermo, come un'app.
          </span>
        </div>
      </div>
    );

  return null;
}
