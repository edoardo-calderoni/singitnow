import { Download, Loader2, Mic, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, fmtTime, Recording, recordingUrl } from "../shared/api";

const fmtDay = (t: number) =>
  new Date(t * 1000).toLocaleDateString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Nel profilo: le registrazioni delle proprie esibizioni (voce e base), da scaricare o cancellare. */
export function MyRecordings({ first, last }: { first: string; last: string }) {
  const [list, setList] = useState<Recording[] | null>(null);
  const [keepDays, setKeepDays] = useState(60);
  const load = () =>
    api
      .recordings(first, last)
      .then((r) => {
        setList(r.recordings);
        setKeepDays(r.keep_days);
      })
      .catch(() => setList([]));
  useEffect(() => {
    if (first.trim()) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first, last]);
  // una registrazione appena arrivata è ancora in conversione: si ricontrolla fra poco
  useEffect(() => {
    if (!list?.some((r) => !r.ready)) return;
    const t = window.setTimeout(load, 4000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  if (!list?.length) return null;
  return (
    <div className="m-recordings">
      <div className="m-recordings-title">
        <Mic size={15} /> Le tue registrazioni
      </div>
      <ol>
        {list.map((r) => (
          <li key={r.id}>
            <div className="ellipsis">
              <b>{r.title}</b>
              <div className="muted">
                {fmtDay(r.t)} · {fmtTime(r.seconds)}
                {r.names.length > 1 && ` · ${r.names.join(" e ")}`}
              </div>
            </div>
            {r.ready ? (
              <a className="icon-btn" title="Scarica" href={recordingUrl(r.id, first, last)} download>
                <Download size={18} />
              </a>
            ) : (
              <span className="icon-btn" title="In preparazione">
                <Loader2 size={18} className="spin" />
              </span>
            )}
            <button
              type="button"
              className="icon-btn danger"
              title="Cancella"
              onClick={() => {
                if (!confirm(`Cancellare la registrazione di «${r.title}»?`)) return;
                api
                  .deleteRecording(r.id, first, last)
                  .then(load)
                  .catch(() => {});
              }}
            >
              <Trash2 size={18} />
            </button>
          </li>
        ))}
      </ol>
      <div className="m-mode-hint">Si cancellano da sole dopo {keepDays} giorni</div>
    </div>
  );
}
