import { useEffect, useRef, useState } from "react";

const AFTER_MS = 5000; // brevi interruzioni (Wi-Fi che si riaggancia) non coprono la pagina

/**
 * Connessione al PC persa da più di 5 secondi: schermata come quella d'avvio dell'app (logo al centro,
 * messaggio e rotellina) finché non ci si ricollega. Solo dopo essere stati collegati almeno una volta:
 * all'apertura la connessione impiega un attimo e la ricerca del PC la mostra già l'app.
 */
export function ConnectionLost({ connected }: { connected: boolean }) {
  const wasConnected = useRef(false);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (connected) {
      wasConnected.current = true;
      setShown(false);
      return;
    }
    if (!wasConnected.current) return;
    const id = window.setTimeout(() => setShown(true), AFTER_MS);
    return () => window.clearTimeout(id);
  }, [connected]);
  if (!shown) return null;
  return (
    <div className="m-lost" role="alert" aria-live="assertive">
      <div className="m-lost-brand">
        <img src="/icon.svg" alt="" />
        <span>
          Sing<span className="grad-text">IT</span>now
        </span>
      </div>
      <p>Connessione persa, provo a riconnettermi...</p>
      <div className="m-lost-spinner" aria-hidden />
    </div>
  );
}
