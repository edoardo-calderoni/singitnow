import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import "./desktop.css";
import { App } from "./App";

/**
 * Su schermi grandi (TV) l'interfaccia si ingrandisce in proporzione:
 * progettata per ~1440px di larghezza, scala fino a 1.6x.
 */
function applyZoom() {
  const z = Math.min(1.6, Math.max(0.85, window.innerWidth / 1440));
  document.documentElement.style.setProperty("--ui-zoom", z.toFixed(3));
}
applyZoom();
window.addEventListener("resize", applyZoom);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
