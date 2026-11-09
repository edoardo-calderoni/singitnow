import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import "./desktop.css";
import { App } from "./App";

/**
 * Su schermi grandi (TV) l'interfaccia si ingrandisce in proporzione:
 * progettata per ~1440×810 (16:9), scala fino a 1.6x. Conta anche l'altezza: su un monitor
 * ultra-wide (21:9) o in una finestra bassa la sola larghezza la ingrandiva più di quanto
 * ci stesse in altezza, e i pulsanti in fondo ai riquadri uscivano dallo schermo.
 */
function applyZoom() {
  const fit = Math.min(window.innerWidth / 1440, window.innerHeight / 810);
  const z = Math.min(1.6, Math.max(0.85, fit));
  document.documentElement.style.setProperty("--ui-zoom", z.toFixed(3));
}
applyZoom();
window.addEventListener("resize", applyZoom);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
