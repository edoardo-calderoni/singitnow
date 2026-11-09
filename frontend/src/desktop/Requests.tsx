import { useCallback, useEffect, useRef, useState } from "react";
import { Mic2 } from "lucide-react";
import { Song } from "../shared/api";
import { Avatar } from "../shared/Avatar";
import { fmtWait } from "../shared/queue";
import { useJukebox } from "../shared/mode";

export interface RequestEvent {
  singer: string;
  position: number; // posizione in coda, 0 = in preparazione, -1 = parte subito
  wait?: number | null; // secondi stimati prima che venga riprodotto
  song: Song | null;
}

interface Item extends RequestEvent {
  key: number;
  leaving: boolean;
  /** "join" = qualcuno si è collegato dal telefono (nome in `singer`);
   * "duet" = `partner` ha accettato di cantare il brano di `singer` in duetto */
  kind?: "request" | "join" | "duet";
  partner?: string;
}

const SHOW_MS = 7000;
const JOIN_MS = 5000;

const LEAVE_MS = 400;
const MAX_VISIBLE = 3;

/** Gestisce gli avvisi "Richiesta di …": push() ne aggiunge uno, spariscono da soli. */
export function useRequests() {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const add = useCallback((item: Omit<Item, "key" | "leaving">, ms: number) => {
    const key = ++seq.current;
    setItems((prev) => [...prev, { ...item, key, leaving: false }].slice(-MAX_VISIBLE));
    timers.current.push(
      window.setTimeout(() => setItems((prev) => prev.map((i) => (i.key === key ? { ...i, leaving: true } : i))), ms),
      window.setTimeout(() => setItems((prev) => prev.filter((i) => i.key !== key)), ms + LEAVE_MS),
    );
  }, []);
  const push = useCallback((r: RequestEvent) => add({ ...r, kind: "request" }, SHOW_MS), [add]);
  /** «Marco si è unito alla festa!» */
  const pushJoin = useCallback(
    (name: string) => add({ kind: "join", singer: name, position: 0, song: null }, JOIN_MS),
    [add],
  );

  /** «Anna e Marco canteranno in duetto» */
  const pushDuet = useCallback(
    (singer: string, partner: string, song: Song | null) => add({ kind: "duet", singer, partner, position: 0, song }, SHOW_MS),
    [add],
  );

  return { items, push, pushJoin, pushDuet };
}

/** Notifiche sulla TV: in alto a destra durante un brano, in basso a destra nel pannello principale. */
export function RequestToasts({ items, bottom = false }: { items: Item[]; bottom?: boolean }) {
  const jukebox = useJukebox();
  if (!items.length) return null;
  return (
    <div className={`requests ${bottom ? "bottom" : ""}`} aria-live="polite">
      {items.map((r) =>
        r.kind === "join" ? (
          <div key={r.key} className={`request join ${r.leaving ? "leaving" : ""}`}>
            <Avatar name={r.singer} className="join-avatar" />
            <div className="request-body">
              <div className="request-title ellipsis">{r.singer}</div>
              <div className="request-when">ha raggiunto la festa! 🎉</div>
            </div>
          </div>
        ) : r.kind === "duet" ? (
          <div key={r.key} className={`request duet ${r.leaving ? "leaving" : ""}`}>
            <div className="duet-faces">
              <Avatar name={r.singer} className="join-avatar" />
              <Avatar name={r.partner} className="join-avatar" />
            </div>
            <div className="request-body">
              <div className="request-who-text">
                <b>{r.singer}</b> e <b>{r.partner}</b> canteranno in duetto! 🎤
              </div>
              <div className="request-title ellipsis">{r.song?.title ?? "Nuovo duetto"}</div>
              {r.song?.artist && <div className="request-meta ellipsis">{r.song.artist}</div>}
            </div>
          </div>
        ) : (
        <div key={r.key} className={`request ${r.leaving ? "leaving" : ""}`}>
          <div className="request-art">
            <div className="request-cover cover">
              {r.song?.thumbnail_url ? <img src={r.song.thumbnail_url} alt="" /> : <Mic2 />}
            </div>
          </div>
          <div className="request-body">
            <div className="request-who">
              {/* foto di chi ha chiesto il brano, accanto al nome */}
              {r.singer && <Avatar name={r.singer} className="request-avatar" />}
              <span className="request-who-text">
                {r.singer ? (
                  <>
                    Nuovo brano aggiunto da <b>{r.singer}</b>
                  </>
                ) : (
                  "Nuovo brano aggiunto"
                )}
              </span>
            </div>
            <div className="request-title ellipsis">{r.song?.title ?? "Nuovo brano"}</div>
            {r.song?.artist && <div className="request-meta ellipsis">{r.song.artist}</div>}
            {/* playlist ferma in attesa di «Avvia playlist»: solo il primo in coda ha una riga sul quando */}
            {(r.position <= 1 || r.wait != null) && (
              <div className="request-when">
                {r.position < 0
                  ? "Parte ora!"
                  : r.position === 0
                    ? "In preparazione: verrà riprodotto appena pronto"
                    : r.wait != null
                      ? `Verrà riprodotto fra ${fmtWait(r.wait)}`
                      : jukebox
                        ? "È il primo brano della playlist!"
                        : "È il primo ad esibirsi!"}
              </div>
            )}
          </div>
        </div>
        ),
      )}
    </div>
  );
}
