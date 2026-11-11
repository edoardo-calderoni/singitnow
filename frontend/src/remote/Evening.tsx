import { Flag, X } from "lucide-react";
import { useState } from "react";
import { api, PlaylistState } from "../shared/api";
import { useEvening } from "../shared/evening";

/** Titolo e cantante dell'ultimo brano della serata (null se la serata non è in chiusura). */
function useLast(playlist: PlaylistState) {
  const { closing, lastEntry } = useEvening();
  if (!closing || !lastEntry) return null;
  const playing = playlist.now_playing?.id === lastEntry;
  const entry = playing ? playlist.now_playing : playlist.entries.find((e) => e.id === lastEntry);
  if (!entry) return null;
  return { title: entry.song?.title ?? "", singer: entry.singer, playing };
}

/** Per tutti: striscia «Ultimo brano della serata» mentre la serata si sta chiudendo. */
export function EveningBanner({ playlist }: { playlist: PlaylistState }) {
  const last = useLast(playlist);
  if (!last) return null;
  return (
    <div className="m-evening-banner" role="status">
      <span className="m-evening-flag">🏁</span>
      <div>
        <b>{last.playing ? "Questo è l'ultimo brano della serata" : "Il prossimo è l'ultimo brano della serata"}</b>
        <div className="muted">
          «{last.title}»{last.singer && ` · ${last.singer}`} · poi classifica e statistiche
        </div>
      </div>
    </div>
  );
}

/** Amministratori: «Concludi la serata» (con conferma) e, in chiusura, «Annulla». */
export function EveningCard({ playlist }: { playlist: PlaylistState }) {
  const { closing } = useEvening();
  const last = useLast(playlist);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const nothing = !playlist.now_playing && !playlist.entries.length;
  const run = (p: Promise<unknown>) =>
    p.then(() => setError("")).catch((e) => setError(e.message));
  return (
    <div className="m-mode m-evening">
      <div className="m-mode-label">Fine della serata</div>
      {closing ? (
        <>
          <div className="m-mode-hint">
            {last ? (
              <>
                {last.playing ? "Ultimo brano, adesso: " : "Ultimo brano: "}
                <b>«{last.title}»</b>
                {last.singer && ` · ${last.singer}`}. Finito quello: classifica, vincitore e statistiche.
              </>
            ) : (
              "La serata si chiude dopo il prossimo brano."
            )}
          </div>
          <button type="button" className="btn btn-ghost btn-sm m-wifi-show" onClick={() => run(api.cancelEveningClose())}>
            <X size={15} /> Annulla, la serata continua
          </button>
        </>
      ) : asking ? (
        <>
          <div className="m-mode-hint">
            {nothing
              ? "Non c'è niente in coda: la serata si chiude subito."
              : "Avviso tutti che il prossimo brano è l'ultimo: finito quello si vedono classifica, vincitore e statistiche."}
          </div>
          <div className="m-evening-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAsking(false)}>
              Annulla
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setAsking(false);
                run(api.closeEvening());
              }}
            >
              <Flag size={15} /> Sì, concludi
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="m-mode-hint">La serata continua finché non la concludi tu, anche a playlist finita</div>
          <button type="button" className="btn btn-primary btn-sm m-wifi-show" onClick={() => setAsking(true)}>
            <Flag size={15} /> Concludi la serata
          </button>
        </>
      )}
      {error && <div className="m-admin-err">{error}</div>}
    </div>
  );
}
