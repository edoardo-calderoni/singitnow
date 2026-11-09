import { ChevronDown, ChevronUp, Heart, Mic2, Trophy } from "lucide-react";
import { useEffect, useState } from "react";
import { api, Profile } from "../shared/api";

const fmtDay = (t: number) => new Date(t * 1000).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" });

/**
 * Nel profilo: quello che la persona ha fatto in tutte le serate (esibizioni, record personale,
 * brano preferito) e, aprendo la lista, gli ultimi brani cantati con il voto.
 */
export function ProfileHistory({ first, last }: { first: string; last: string }) {
  const [p, setP] = useState<Profile | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (first.trim()) api.profile(first, last).then(setP).catch(() => {});
  }, [first, last]);
  if (!p || (!p.performances && !p.best)) return null;
  return (
    <div className="m-profile-history">
      <div className="m-profile-stats">
        <div>
          <Mic2 size={16} />
          <b>{p.performances}</b>
          <span>{p.performances === 1 ? "esibizione" : "esibizioni"}</span>
        </div>
        {p.best && (
          <div title={`«${p.best.title}», ${fmtDay(p.best.t)}`}>
            <Trophy size={16} />
            <b>{p.best.score}</b>
            <span>record</span>
          </div>
        )}
        {p.favorite && (
          <div title={`«${p.favorite.title}», cantato ${p.favorite.count} volte`}>
            <Heart size={16} />
            <b className="ellipsis">{p.favorite.title}</b>
            <span>preferito</span>
          </div>
        )}
      </div>
      {p.best && (
        <div className="m-profile-best ellipsis">
          Il tuo record: <b>{p.best.score}</b> su «{p.best.title}» ({fmtDay(p.best.t)})
        </div>
      )}
      {p.recent.length > 0 && (
        <>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>
            {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />} I tuoi brani
          </button>
          {open && (
            <ol className="m-profile-songs">
              {p.recent.map((r, i) => (
                <li key={i}>
                  <div className="ellipsis">
                    <b>{r.title}</b>
                    {r.partner && <span className="muted"> · con {r.partner}</span>}
                    <div className="muted">{fmtDay(r.t)}</div>
                  </div>
                  {r.score != null && <b className="m-profile-score">{r.score}</b>}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      {p.first_seen && <div className="m-mode-hint">Con SingITnow dal {fmtDay(p.first_seen)}</div>}
    </div>
  );
}
