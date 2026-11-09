import { Star } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../shared/api";
import { useCompetition } from "../shared/competition";

const VOTED_KEY = "sin.voted"; // esibizioni già votate da questo telefono: {entry_id: stelle}

function readVoted(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(VOTED_KEY) || "{}");
  } catch {
    return {};
  }
}

/**
 * Competizione: a fine brano, per qualche decina di secondi, gli altri partecipanti votano
 * l'esibizione con da 1 a 5 stelle (il voto del pubblico pesa sul punteggio in classifica).
 * Chi ha cantato non vede la richiesta; chi ha già votato può chiudere o cambiare voto.
 */
export function AudienceVote({ name }: { name: string }) {
  const { vote, audience_weight } = useCompetition();
  const [voted, setVoted] = useState<Record<string, number>>(readVoted);
  const [closed, setClosed] = useState<string>(""); // esibizione di cui si è chiusa la richiesta
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    if (!vote) return;
    const t = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(t);
  }, [vote]);

  if (!vote || !name || vote.until <= now || closed === vote.entry_id) return null;
  if (vote.singers.some((s) => s.toLowerCase() === name.toLowerCase())) return null;

  const mine = voted[vote.entry_id] ?? 0;
  const left = Math.max(0, Math.ceil(vote.until - now));
  const who = vote.singers.join(" e ");
  const send = async (stars: number) => {
    setBusy(true);
    setError("");
    try {
      await api.vote(vote.entry_id, name, stars);
      const next = { ...readVoted(), [vote.entry_id]: stars };
      // si tengono solo le ultime esibizioni
      const keep = Object.fromEntries(Object.entries(next).slice(-30));
      try {
        localStorage.setItem(VOTED_KEY, JSON.stringify(keep));
      } catch {
        /* archivio non disponibile */
      }
      setVoted(keep);
      navigator.vibrate?.(30);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="m-sheet m-vote-back" onClick={() => setClosed(vote.entry_id)}>
      <div className="m-sheet-card m-vote-card" role="dialog" aria-labelledby="m-vote-title" onClick={(e) => e.stopPropagation()}>
        <div id="m-vote-title" className="m-sheet-title">
          Vota l'esibizione di {who}
        </div>
        <div className="m-vote-song">«{vote.title}»</div>
        <div className="m-vote-stars" role="radiogroup" aria-label="Stelle">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={mine === n}
              aria-label={`${n} stell${n === 1 ? "a" : "e"}`}
              className={n <= mine ? "on" : ""}
              disabled={busy}
              onClick={() => send(n)}
            >
              <Star size={38} fill={n <= mine ? "currentColor" : "none"} />
            </button>
          ))}
        </div>
        {error ? (
          <div className="m-vote-note err">{error}</div>
        ) : mine ? (
          <div className="m-vote-note">Grazie! Puoi cambiare voto ancora per {left} s</div>
        ) : (
          <div className="m-vote-note">
            Il voto del pubblico vale il {Math.round((audience_weight ?? 0.3) * 100)}% del punteggio · {left} s
          </div>
        )}
        <button type="button" className="btn btn-ghost btn-wide" onClick={() => setClosed(vote.entry_id)}>
          {mine ? "Chiudi" : "Non voto"}
        </button>
      </div>
    </div>
  );
}
