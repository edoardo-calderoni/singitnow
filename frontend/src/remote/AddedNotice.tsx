import { useCallback, useEffect, useRef, useState } from "react";
import { Music } from "lucide-react";
import { Song } from "../shared/api";
import { useMode } from "../shared/mode";

interface Notice {
  key: number;
  singer: string;
  song: Song | null;
  position: number; // -1 = parte subito, 0 = in preparazione, n = posizione in coda
  wait: number | null; // secondi stimati prima che venga riprodotto (null = playlist ferma)
  approvedBy: string | null; // modalità DJ: richiesta accettata da questo DJ
  leaving: boolean;
}

const SHOW_MS = 5000;
const APPROVED_MS = 7000; // l'avviso di richiesta accettata è più lungo da leggere
const LEAVE_MS = 300;

interface AddedEvent {
  singer?: string;
  song?: Song | null;
  position?: number;
  wait?: number | null;
  approved_by?: string;
}

/**
 * Avviso sul brano entrato in playlist. push() riceve l'evento "added" del server, che arriva quando
 * il brano entra davvero in coda (subito se è già pronto, altrimenti a fine preparazione), anche per i
 * brani aggiunti dal PC.
 * - Karaoke e Jukebox: «Nuovo brano aggiunto alla playlist.» per tutti tranne chi canta il brano.
 * - DJ: nessun avviso per gli altri; solo chi ha chiesto il brano riceve «<DJ> ha accettato la tua
 *   richiesta!» quando il DJ lo accetta (se la rifiuta, nessun avviso).
 */
export function useAddedNotice(myName: string) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const seq = useRef(0);
  const timers = useRef<number[]>([]);
  const nameRef = useRef(myName);
  nameRef.current = myName;
  const mode = useMode();
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const push = useCallback((data: AddedEvent) => {
    if (!data?.song) return;
    const singer = (data.singer ?? "").trim();
    const mine = !!singer && singer.toLocaleLowerCase() === nameRef.current.trim().toLocaleLowerCase();
    const approvedBy = typeof data.approved_by === "string" ? data.approved_by.trim() || "Il DJ" : null;
    if (approvedBy !== null) {
      if (!mine) return; // richiesta accettata: l'avviso è solo per chi l'ha fatta
    } else if (modeRef.current === "dj" || mine) {
      return; // in modalità DJ gli altri non ricevono avvisi; chi canta il brano non ne ha bisogno
    }
    timers.current.forEach(clearTimeout);
    const key = ++seq.current;
    // il nuovo avviso sostituisce il precedente
    setNotice({
      key,
      singer,
      song: data.song,
      position: data.position ?? 0,
      wait: typeof data.wait === "number" ? data.wait : null,
      approvedBy,
      leaving: false,
    });
    const ms = approvedBy !== null ? APPROVED_MS : SHOW_MS;
    timers.current = [
      window.setTimeout(() => setNotice((n) => (n?.key === key ? { ...n, leaving: true } : n)), ms),
      window.setTimeout(() => setNotice((n) => (n?.key === key ? null : n)), ms + LEAVE_MS),
    ];
  }, []);

  return { notice, push };
}

/** «fra 5 minuti», «fra 1 minuto», «fra meno di un minuto», «fra 1 ora e 10 minuti». */
function fmtIn(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 1) return "fra meno di un minuto";
  if (m < 60) return `fra ${m} ${m === 1 ? "minuto" : "minuti"}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  const hours = `${h} ${h === 1 ? "ora" : "ore"}`;
  return rest ? `fra ${hours} e ${rest} ${rest === 1 ? "minuto" : "minuti"}` : `fra ${hours}`;
}

/** Frase della richiesta accettata dal DJ, con quando verrà suonato il brano. */
function approvedText(n: Notice) {
  const when =
    n.position === -1
      ? " e sta per partire!"
      : n.wait !== null && n.position > 0
        ? ` e verrà suonato ${fmtIn(n.wait)}.`
        : ".";
  return (
    <>
      <b>{n.approvedBy}</b> ha accettato la tua richiesta! Il brano è stato inserito nella playlist{when}
    </>
  );
}

/** Avviso in alto sopra l'intestazione: copertina, titolo e autore e, sotto, il messaggio.
 * Non copre i contenuti né il testo e lascia passare i tocchi. */
export function AddedNotice({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  const song = notice.song;
  return (
    <div key={notice.key} className={`m-added ${notice.leaving ? "leaving" : ""}`} role="status" aria-live="polite">
      <div className="m-added-row">
        <div className="m-added-cover cover">
          {song?.thumbnail_url ? <img src={song.thumbnail_url} alt="" /> : <Music size={22} />}
        </div>
        <div className="m-added-body">
          <div className="m-added-title">{song?.title || "Nuovo brano"}</div>
          {song?.artist && <div className="m-added-artist">{song.artist}</div>}
          <div className="m-added-msg">
            {notice.approvedBy !== null ? approvedText(notice) : "Nuovo brano aggiunto alla playlist."}
          </div>
        </div>
      </div>
    </div>
  );
}
