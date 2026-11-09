import { Clock, Loader2, X } from "lucide-react";
import { api, fmtEta, fmtTime, PlaylistState } from "../shared/api";
import { Avatar } from "../shared/Avatar";

type Safe = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

/**
 * Pannello Live: brani prenotati ancora in preparazione. Non fanno parte della playlist (ci entrano
 * quando sono pronti); qui chi li ha prenotati, e gli amministratori o il DJ, possono annullarli.
 */
export function Preparing({
  waiting,
  name,
  canManage,
  canWithdraw = true,
  safe,
}: {
  waiting: PlaylistState["waiting"];
  name: string;
  canManage: boolean;
  canWithdraw?: boolean; // false con «Blocca inserimenti e richieste»
  safe: Safe;
}) {
  const shown = canManage ? waiting : waiting.filter((w) => w.singer === name);
  if (!shown.length) return null;
  return (
    <>
      <h2 className="m-h2">{canManage ? `In preparazione (${shown.length})` : "In preparazione"}</h2>
      <ol className="m-list m-requests">
        {shown.map((w, i) => (
          <li key={`${w.song_id}-${w.singer}-${i}`} className="m-item m-qitem waiting">
            <div className="m-pos">
              <Loader2 size={14} className="spin" />
            </div>
            {w.song?.thumbnail_url && <img className="m-qbg" src={w.song.thumbnail_url} alt="" />}
            <div className="m-item-main">
              <div className="m-item-title wrap">{w.song?.title}</div>
              {w.song?.artist && <div className="m-item-artist">{w.song.artist}</div>}
              <div className="m-item-meta">
                {!!w.song?.duration && (
                  <span>
                    <Clock size={13} /> {fmtTime(w.song.duration)}
                  </span>
                )}
                <span className="m-wait">
                  {Math.round((w.song?.progress ?? 0) * 100)}%{fmtEta(w.song) && ` · ${fmtEta(w.song)}`}
                </span>
              </div>
              {/* su una riga a sé: così va a capo invece di essere tagliata */}
              <div className="m-wait-note">Entra in playlist appena pronto</div>
              {canManage && w.singer && (
                <div className="m-qsinger">
                  <Avatar name={w.singer} className="xs" /> <b>{w.singer}</b>
                </div>
              )}
            </div>
            {(canManage || (w.singer === name && canWithdraw)) && (
              <button
                className="icon-btn danger"
                title="Annulla: l'importazione si ferma e il brano viene cancellato"
                onClick={() => {
                  if (!confirm(`Annullare «${w.song?.title ?? "il brano"}»? L'importazione si ferma e il brano viene cancellato.`)) return;
                  safe(() => api.unqueueWaiting(w.song_id, w.singer), "Brano annullato");
                }}
              >
                <X size={18} />
              </button>
            )}
          </li>
        ))}
      </ol>
    </>
  );
}
