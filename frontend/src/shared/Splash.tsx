import { useEffect, useRef, useState } from "react";

/**
 * Video di avvio a schermo intero: sul PC public/splash.mp4 (orizzontale, con effetti sonori), sul
 * telefono public/splash-mobile.mp4 (verticale, muto). Parte all'apertura dell'app e, finito, lascia
 * la schermata principale (il video sfuma già nel colore di fondo). Un tocco, un clic o un tasto lo
 * saltano. Solo una volta per avvio: ricaricando la pagina non riparte.
 */
const SEEN = "sin.splash";
// immagine trasparente di 1 pixel: sostituisce l'icona predefinita del lettore video
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function alreadySeen(): boolean {
  try {
    return sessionStorage.getItem(SEEN) === "1";
  } catch {
    return false;
  }
}

export function useSplash(): [boolean, () => void] {
  const [show, setShow] = useState(() => !alreadySeen());
  const done = () => {
    try {
      sessionStorage.setItem(SEEN, "1");
    } catch {
      /* niente */
    }
    setShow(false);
  };
  return [show, done];
}

export function Splash({ onDone, src = "/splash.mp4", muted = false }: { onDone: () => void; src?: string; muted?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const finish = () => done.current();
    const skip = finish;
    window.addEventListener("keydown", skip);
    // video mancante o bloccato: non si resta mai fermi sul nero
    const guard = window.setTimeout(finish, 12000);
    video.current?.play().catch(() => {
      // audio non permesso senza un clic: lo si fa partire muto
      if (video.current) {
        video.current.muted = true;
        video.current.play().catch(finish);
      }
    });
    return () => {
      window.removeEventListener("keydown", skip);
      window.clearTimeout(guard);
    };
  }, []);
  return (
    <div className="splash" onClick={onDone}>
      {/* nascosto finché non parte davvero: niente anteprima grigia del lettore (Android) */}
      <video
        ref={video}
        src={src}
        muted={muted}
        playsInline
        preload="auto"
        poster={BLANK}
        className={playing ? "on" : ""}
        onPlaying={() => setPlaying(true)}
        onEnded={onDone}
        onError={onDone}
      />
    </div>
  );
}
