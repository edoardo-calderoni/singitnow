import { Check, Clock, Headphones, X } from "lucide-react";
import { DjRequest, fmtEta, fmtPrep, fmtTime } from "../shared/api";
import { Avatar } from "../shared/Avatar";

type Safe = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

/**
 * Modalità DJ, pannello Live. Il DJ (e gli amministratori) vede le richieste degli utenti e le
 * accetta o rifiuta; chi ha chiesto un brano vede le proprie richieste «In attesa del DJ».
 */
export function DjRequests({
  requests,
  name,
  canManage,
  canWithdraw = true,
  safe,
  approve,
  reject,
}: {
  requests: DjRequest[];
  name: string;
  canManage: boolean;
  canWithdraw?: boolean; // false con «Blocca inserimenti e richieste»
  safe: Safe;
  approve: (id: string) => Promise<unknown>;
  reject: (id: string) => Promise<unknown>;
}) {
  const shown = canManage ? requests : requests.filter((r) => r.singer === name);
  if (!shown.length) return null;
  return (
    <>
      <h2 className="m-h2">{canManage ? `Richieste (${shown.length})` : "Le tue richieste"}</h2>
      <ol className="m-list m-requests">
        {shown.map((r) => (
          <li key={r.id} className="m-item m-qitem">
            <div className="m-pos">
              <Headphones size={14} />
            </div>
            {r.song?.thumbnail_url && <img className="m-qbg" src={r.song.thumbnail_url} alt="" />}
            <div className="m-item-main">
              <div className="m-item-title wrap">{r.song?.title}</div>
              {r.song?.artist && <div className="m-item-artist">{r.song.artist}</div>}
              <div className="m-item-meta">
                {!!r.song?.duration && (
                  <span>
                    <Clock size={13} /> {fmtTime(r.song.duration)}
                  </span>
                )}
                {r.song && r.song.status !== "ready" && r.song.status !== "error" && (
                  <span className="m-wait">
                    in preparazione {fmtPrep(r.song)}
                    {fmtEta(r.song) && ` · ${fmtEta(r.song)}`}
                  </span>
                )}
                {!canManage && <span className="m-wait">In attesa del DJ</span>}
              </div>
              {canManage && r.singer && (
                <div className="m-qsinger">
                  <Avatar name={r.singer} className="xs" /> <b>{r.singer}</b>
                </div>
              )}
            </div>
            {canManage ? (
              <div className="m-req-actions">
                <button
                  className="icon-btn m-req-ok"
                  title="Accetta: il brano entra in playlist"
                  onClick={() => safe(() => approve(r.id), "Richiesta accettata")}
                >
                  <Check size={20} />
                </button>
                <button className="icon-btn danger" title="Rifiuta" onClick={() => safe(() => reject(r.id), "Richiesta rifiutata")}>
                  <X size={20} />
                </button>
              </div>
            ) : (
              canWithdraw && (
              <button className="icon-btn danger" title="Ritira la richiesta" onClick={() => safe(() => reject(r.id), "Richiesta ritirata")}>
                <X size={18} />
              </button>
              )
            )}
          </li>
        ))}
      </ol>
    </>
  );
}
