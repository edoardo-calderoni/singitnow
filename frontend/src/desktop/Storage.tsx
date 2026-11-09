import { HardDrive, Loader2, Music2, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, StorageReport } from "../shared/api";

/** Byte in forma leggibile: «850 MB», «1,4 GB». */
export function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${(n / 1024 ** 3).toFixed(1).replace(".", ",")} GB`;
}

/** Voce dei Settaggi: apre il pannello dello spazio su disco. */
export function StorageSetting({ onError }: { onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="setting">
      <div className="setting-title">Spazio su disco</div>
      <p className="setting-desc">Quanto occupa ogni brano; elimina tonalità trasposte e brani mai suonati.</p>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        <HardDrive size={15} /> Gestisci lo spazio
      </button>
      {open && createPortal(<StorageDialog onClose={() => setOpen(false)} onError={onError} />, document.body)}
    </div>
  );
}

function StorageDialog({ onClose, onError }: { onClose: () => void; onError: (m: string) => void }) {
  const [r, setR] = useState<StorageReport | null>(null);
  const [onlyNever, setOnlyNever] = useState(false);
  const [busy, setBusy] = useState("");
  const load = useCallback(() => api.storage().then(setR).catch((e) => onError(e.message)), [onError]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const never = r?.songs.filter((s) => s.never_played && s.status === "ready") ?? [];
  const neverSize = never.reduce((a, s) => a + s.total, 0);
  const shown = (onlyNever ? never : r?.songs) ?? [];
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal storage-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Spazio su disco</h3>
          <button type="button" className="icon-btn" title="Chiudi" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {!r ? (
          <Loader2 className="spin" />
        ) : (
          <>
            <div className="storage-totals">
              <div>
                <b>{fmtBytes(r.library)}</b> libreria ({r.songs.length} brani)
              </div>
              <div>
                <b>{fmtBytes(r.recordings)}</b> registrazioni
              </div>
              <div>
                <b>{fmtBytes(r.models)}</b> modelli AI
              </div>
              <div>
                <b>{fmtBytes(r.free)}</b> liberi sul disco
              </div>
            </div>
            <div className="storage-actions">
              <button
                className="btn btn-ghost btn-sm"
                disabled={!r.keys || !!busy}
                onClick={() => run("keys", () => api.clearKeys())}
              >
                {busy === "keys" ? <Loader2 size={15} className="spin" /> : <Music2 size={15} />} Elimina le tonalità
                trasposte ({fmtBytes(r.keys)})
              </button>
              {r.work > 0 && (
                <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => run("work", () => api.clearWork())}>
                  <Trash2 size={15} /> Residui di importazioni interrotte ({fmtBytes(r.work)})
                </button>
              )}
              <button
                className="btn btn-ghost btn-sm danger"
                disabled={!never.length || !!busy}
                onClick={() => {
                  if (!confirm(`Eliminare ${never.length} brani mai suonati (${fmtBytes(neverSize)})? Non si possono recuperare.`)) return;
                  run("never", async () => {
                    for (const s of never) await api.deleteSong(s.id);
                  });
                }}
              >
                {busy === "never" ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />} Elimina i mai suonati (
                {never.length}, {fmtBytes(neverSize)})
              </button>
            </div>
            <label className="storage-filter">
              <input type="checkbox" checked={onlyNever} onChange={(e) => setOnlyNever(e.target.checked)} /> Solo i brani mai
              suonati
            </label>
            <p className="storage-note">
              «Mai suonato»: nessuna riproduzione da quando SingITnow le tiene a mente e nessun voto salvato.
            </p>
            <ol className="storage-list">
              {shown.map((s) => (
                <li key={s.id}>
                  <div className="storage-song">
                    <b className="ellipsis">{s.title}</b>
                    <span className="muted ellipsis">
                      {s.artist}
                      {s.never_played && <span className="badge">mai suonato</span>}
                    </span>
                  </div>
                  <div className="storage-sizes muted">
                    video {fmtBytes(s.sizes.video)} · tracce {fmtBytes(s.sizes.audio)}
                    {s.sizes.keys > 0 && ` · tonalità ${fmtBytes(s.sizes.keys)}`}
                  </div>
                  <b className="storage-total">{fmtBytes(s.total)}</b>
                  <div className="storage-row-actions">
                    {s.sizes.keys > 0 && (
                      <button
                        className="icon-btn"
                        title="Elimina le tonalità trasposte"
                        disabled={!!busy}
                        onClick={() => run(s.id, () => api.clearKeys(s.id))}
                      >
                        <Music2 size={16} />
                      </button>
                    )}
                    <button
                      className="icon-btn danger"
                      title="Elimina il brano dalla libreria"
                      disabled={!!busy}
                      onClick={() => {
                        if (!confirm(`Eliminare «${s.title}» dalla libreria?`)) return;
                        run(s.id, () => api.deleteSong(s.id));
                      }}
                    >
                      {busy === s.id ? <Loader2 size={16} className="spin" /> : <Trash2 size={16} />}
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}
