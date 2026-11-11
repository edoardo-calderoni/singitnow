import { Flag, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, PlaylistState, Song } from "../shared/api";
import { useEvening } from "../shared/evening";

/** Titolo e cantante dell'ultimo brano della serata (dalla playlist). */
export function useLastSong(playlist: PlaylistState | null, songs: Song[]) {
  const { closing, lastEntry } = useEvening();
  if (!closing || !lastEntry || !playlist) return null;
  const entry = playlist.now_playing?.id === lastEntry ? playlist.now_playing : playlist.entries.find((e) => e.id === lastEntry);
  if (!entry) return null;
  const song = songs.find((s) => s.id === entry.song_id);
  return {
    title: song?.title ?? "",
    singer: entry.singer || "",
    playing: playlist.now_playing?.id === lastEntry,
  };
}

/**
 * Barra laterale: «Concludi la serata» (con conferma). In chiusura mostra qual è l'ultimo brano e
 * permette di annullare.
 */
export function EveningButton({
  playlist,
  songs,
  onError,
}: {
  playlist: PlaylistState | null;
  songs: Song[];
  onError: (msg: string) => void;
}) {
  const { closing } = useEvening();
  const last = useLastSong(playlist, songs);
  const [asking, setAsking] = useState(false);
  const busy = useRef(false);
  const run = (p: Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    p.catch((e) => onError(e.message)).finally(() => (busy.current = false));
  };
  const nothing = !playlist?.now_playing && !playlist?.entries.length;

  if (closing) {
    return (
      <div className="evening-box">
        <div className="evening-box-title">
          <Flag size={14} /> Serata in chiusura
        </div>
        {last && (
          <div className="evening-box-last">
            {last.playing ? "Ultimo brano, adesso: " : "Ultimo brano: "}
            <b>{last.title}</b>
            {last.singer && ` · ${last.singer}`}
          </div>
        )}
        <button className="btn btn-ghost btn-sm" onClick={() => run(api.cancelEveningClose())}>
          <X size={14} /> Annulla
        </button>
      </div>
    );
  }
  return (
    <>
      <button className="btn btn-ghost btn-sm evening-btn" onClick={() => setAsking(true)}>
        <Flag size={15} /> Concludi la serata
      </button>
      {asking &&
        createPortal(
          <div className="modal-back" onClick={() => setAsking(false)}>
            <div className="modal notice-modal" role="alertdialog" onClick={(e) => e.stopPropagation()}>
              <div className="notice-icon">
                <Flag size={26} />
              </div>
              <p>
                {nothing
                  ? "Non c'è niente in coda: la serata si chiude subito, con la classifica e le statistiche."
                  : "Avviso tutti che il prossimo brano è l'ultimo. Finito quello la TV mostra la classifica, il vincitore e le statistiche della serata."}
              </p>
              <div className="actions">
                <button className="btn btn-ghost" onClick={() => setAsking(false)}>
                  Annulla
                </button>
                <button
                  className="btn btn-primary"
                  autoFocus
                  onClick={() => {
                    setAsking(false);
                    run(api.closeEvening());
                  }}
                >
                  Concludi la serata
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

const NOTICE_SECONDS = 8;

/** Sulla TV, quando si conclude la serata: «Ultimo brano della serata» a tutto schermo per qualche secondo. */
export function EveningNotice({ playlist, songs }: { playlist: PlaylistState | null; songs: Song[] }) {
  const { closing, lastEntry } = useEvening();
  const last = useLastSong(playlist, songs);
  const [shown, setShown] = useState<string | null>(null);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!closing || !lastEntry) {
      seen.current = null;
      setShown(null);
      return;
    }
    if (seen.current === lastEntry) return; // già annunciato
    seen.current = lastEntry;
    setShown(lastEntry);
    const t = window.setTimeout(() => setShown(null), NOTICE_SECONDS * 1000);
    return () => window.clearTimeout(t);
  }, [closing, lastEntry]);
  if (!shown || !last) return null;
  return (
    <div className="evening-notice" onClick={() => setShown(null)}>
      <div className="evening-notice-card">
        <div className="evening-notice-flag">🏁</div>
        <div className="evening-notice-kicker">{last.playing ? "Questo è l'ultimo brano della serata" : "Il prossimo è l'ultimo brano della serata"}</div>
        <div className="evening-notice-title">{last.title}</div>
        {last.singer && <div className="evening-notice-singer">canta {last.singer}</div>}
        <div className="evening-notice-hint">Poi classifica, vincitore e statistiche!</div>
      </div>
    </div>
  );
}
