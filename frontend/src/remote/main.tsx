import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import "./remote.css";
import { App } from "./App";
import { Splash, useSplash } from "../shared/Splash";

/** L'app del telefono con, all'apertura, il video di avvio verticale (senza audio). */
function Root() {
  const [splash, splashDone] = useSplash();
  return (
    <>
      <App />
      {splash && <Splash src="/splash-mobile.mp4" muted onDone={splashDone} />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
