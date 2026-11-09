import { Smartphone, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useCompetition } from "../shared/competition";

/**
 * Competizione: mentre il pubblico vota dal telefono l'esibizione appena finita, sulla TV un
 * banner in basso invita a votare e mostra quanti voti sono arrivati e quanto manca.
 */
export function VoteBanner() {
  const { vote } = useCompetition();
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!vote) return;
    const t = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(t);
  }, [vote]);
  if (!vote || vote.until <= now) return null;
  const left = Math.ceil(vote.until - now);
  return createPortal(
    <div className="vote-banner" role="status">
      <Smartphone size={22} />
      <span>
        Votate dal telefono l'esibizione di <b>{vote.singers.join(" e ")}</b>
      </span>
      <span className="vote-count">
        <Star size={18} fill="currentColor" /> {vote.votes} {vote.votes === 1 ? "voto" : "voti"} · {left} s
      </span>
    </div>,
    document.body,
  );
}
