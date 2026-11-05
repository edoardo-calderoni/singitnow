import { useCallback, useEffect, useRef, useState } from "react";
import { Mic2 } from "lucide-react";
import { Song } from "../shared/api";
import { Avatar } from "../shared/Avatar";

export interface RequestEvent {
  singer: string;
  position: number; // posizione in coda, 0 = in preparazione, -1 = parte subito
  song: Song | null;
}

interface Item extends RequestEvent {
  key: number;
  leaving: boolean;
}

const SHOW_MS = 7000;
const LEAVE_MS = 400;
const MAX_VISIBLE = 3;

/** Gestisce gli avvisi "Richiesta di …": push() ne aggiunge uno, spariscono da soli. */
export function useRequests() {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const push = useCallback((r: RequestEvent) => {
    const key = ++seq.current;
    setItems((prev) => [...prev, { ...r, key, leaving: false }].slice(-MAX_VISIBLE));
    timers.current.push(
      window.setTimeout(() => setItems((prev) => prev.map((i) => (i.key === key ? { ...i, leaving: true } : i))), SHOW_MS),
      window.setTimeout(() => setItems((prev) => prev.filter((i) => i.key !== key)), SHOW_MS + LEAVE_MS),
    );
  }, []);

  return { items, push };
}

export function RequestToasts({ items }: { items: Item[] }) {
  if (!items.length) return null;
  return (
    <div className="requests" aria-live="polite">
      {items.map((r) => (
        <div key={r.key} className={`request ${r.leaving ? "leaving" : ""}`}>
          <div className="request-art">
            <div className="request-cover cover">
              {r.song?.thumbnail_url ? <img src={r.song.thumbnail_url} alt="" /> : <Mic2 />}
            </div>
            <Avatar name={r.singer} className="request-avatar" />
          </div>
          <div className="request-body">
            <div className="request-who ellipsis">
              Richiesta di <b>{r.singer}</b>
            </div>
            <div className="request-title ellipsis">{r.song?.title ?? "Nuovo brano"}</div>
            <div className="request-meta ellipsis">
              {r.song?.artist && <>{r.song.artist} · </>}
              {r.position > 0 ? `n° ${r.position} in coda` : r.position < 0 ? "parte ora!" : "in preparazione"}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
