import { useEffect, useState } from "react";

const ACK_KEY = "sin.djAck"; // elezione di cui si è già visto l'avviso (non si ripete a ogni apertura)

/** Giradischi: piatto con il disco che gira, etichetta colorata e braccio. */
export function Turntable({ size = 120 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" aria-hidden className="turntable">
      <defs>
        <linearGradient id="tt-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff3d9a" />
          <stop offset=".55" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      {/* base */}
      <rect x="4" y="10" width="112" height="100" rx="16" fill="#1e1b34" stroke="url(#tt-grad)" strokeWidth="2.5" />
      {/* disco con i solchi */}
      <g className="turntable-disc">
        <circle cx="52" cy="60" r="38" fill="#0b0b14" />
        <circle cx="52" cy="60" r="32" fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="1.2" />
        <circle cx="52" cy="60" r="26" fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="1.2" />
        <circle cx="52" cy="60" r="20" fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="1.2" />
        <path d="M30 40 A30 30 0 0 1 52 30" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeLinecap="round" />
        <circle cx="52" cy="60" r="11" fill="url(#tt-grad)" />
        <circle cx="52" cy="60" r="2.5" fill="#0b0b14" />
      </g>
      {/* braccio */}
      <circle cx="100" cy="26" r="6" fill="#2a2647" stroke="url(#tt-grad)" strokeWidth="2" />
      <path d="M100 26 L100 70 L84 86" fill="none" stroke="url(#tt-grad)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="78" y="82" width="11" height="8" rx="2" transform="rotate(-45 83.5 86)" fill="#f4f3ff" />
      {/* manopole */}
      <circle cx="100" cy="98" r="3.5" fill="url(#tt-grad)" />
      <circle cx="88" cy="98" r="3.5" fill="rgba(255,255,255,0.25)" />
    </svg>
  );
}

/**
 * Avviso al centro dello schermo per chi viene eletto DJ della serata: una volta per elezione
 * (identificata dall'istante dell'elezione), anche se l'app viene aperta dopo.
 */
export function DjElected({ iAmDj, electedAt }: { iAmDj: boolean; electedAt: number }) {
  const [open, setOpen] = useState(false);
  const id = String(electedAt);
  useEffect(() => {
    if (!iAmDj) return setOpen(false);
    let ack: string | null = null;
    try {
      ack = localStorage.getItem(ACK_KEY);
    } catch {
      /* archivio non disponibile */
    }
    if (ack !== id) setOpen(true);
  }, [iAmDj, id]);

  if (!open) return null;
  const close = () => {
    setOpen(false);
    try {
      localStorage.setItem(ACK_KEY, id);
    } catch {
      /* archivio non disponibile */
    }
  };
  return (
    <div className="m-sheet m-dj-back" onClick={close}>
      <div className="m-sheet-card m-dj-card" role="alertdialog" aria-labelledby="m-dj-text" onClick={(e) => e.stopPropagation()}>
        <Turntable />
        <p id="m-dj-text">
          <b>Sei stato eletto DJ della serata!</b>
          <br />
          Solo tu potrai aggiungere brani alla playlist, facci sognare!
        </p>
        <button type="button" className="btn btn-primary btn-wide" autoFocus onClick={close}>
          Ok
        </button>
      </div>
    </div>
  );
}
