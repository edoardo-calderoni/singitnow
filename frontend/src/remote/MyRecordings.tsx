import { Clapperboard, Download, Loader2, Mic, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, fmtTime, Recording, recordingUrl, recordingVideoUrl, VideoKind, VideoState } from "../shared/api";

const KINDS: { kind: VideoKind; label: string; hint: string }[] = [
  { kind: "story", label: "Storia", hint: "60 s, il ritornello" },
  { kind: "full", label: "Video intero", hint: "tutta l'esibizione" },
];

/** I due video verticali (testo karaoke sulla registrazione): si chiedono al PC e poi si scaricano. */
function Videos({ r, first, last, onChange }: { r: Recording; first: string; last: string; onChange: () => void }) {
  const [asked, setAsked] = useState<Partial<Record<VideoKind, VideoState>>>({});
  const make = (kind: VideoKind) => {
    setAsked((a) => ({ ...a, [kind]: "working" }));
    api
      .recordingVideo(r.id, kind, first, last)
      .then(onChange)
      .catch(() => setAsked((a) => ({ ...a, [kind]: "error" })));
  };
  return (
    <div className="m-rec-videos">
      {KINDS.map(({ kind, label, hint }) => {
        const st = r.videos?.[kind] || asked[kind] || "";
        return (
          <div key={kind} className="m-rec-video">
            <div>
              <b>{label}</b>
              <div className="muted">{st === "working" ? "Preparo il video…" : st === "error" ? "Non riuscito" : hint}</div>
            </div>
            {st === "ready" ? (
              <a className="btn btn-primary btn-sm" href={recordingVideoUrl(r.id, kind, first, last)} download>
                <Download size={15} /> Scarica
              </a>
            ) : st === "working" ? (
              <span className="icon-btn">
                <Loader2 size={18} className="spin" />
              </span>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => make(kind)}>
                {st === "error" ? "Riprova" : "Crea"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

const fmtDay = (t: number) =>
  new Date(t * 1000).toLocaleDateString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Nel profilo: le registrazioni delle proprie esibizioni (voce e base), da scaricare o cancellare. */
export function MyRecordings({ first, last }: { first: string; last: string }) {
  const [list, setList] = useState<Recording[] | null>(null);
  const [keepDays, setKeepDays] = useState(60);
  const [open, setOpen] = useState<string | null>(null); // registrazione con i video aperti
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
  // una registrazione appena arrivata è ancora in conversione (o un video in preparazione): si
  // ricontrolla fra poco
  useEffect(() => {
    if (!list?.some((r) => !r.ready || Object.values(r.videos ?? {}).includes("working"))) return;
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
            {r.ready && (
              <button
                type="button"
                className={`icon-btn${open === r.id ? " on" : ""}`}
                title="Video con il testo"
                onClick={() => setOpen(open === r.id ? null : r.id)}
              >
                <Clapperboard size={18} />
              </button>
            )}
            {r.ready ? (
              <a className="icon-btn" title="Scarica l'audio" href={recordingUrl(r.id, first, last)} download>
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
            {open === r.id && r.ready && <Videos r={r} first={first} last={last} onChange={load} />}
          </li>
        ))}
      </ol>
      <div className="m-mode-hint">Si cancellano da sole dopo {keepDays} giorni</div>
    </div>
  );
}
