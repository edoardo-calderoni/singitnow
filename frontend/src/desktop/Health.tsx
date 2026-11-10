import { AlertTriangle, EyeOff, Loader2, Pencil, RefreshCw, Stethoscope, Trash2, Wand2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, HealthReport, Song } from "../shared/api";
import { EditDialog, LyricsDialog } from "./Dialogs";

const LEVEL_LABEL = { error: "Da sistemare", warn: "Da controllare", info: "Da sapere" } as const;
/** Problemi che «Ripara» sistema da solo: testo fuori tempo o non verificabile. */
const REPAIRABLE = ["lyrics_off", "lyrics_partial", "lyrics_unverified"];
type HealthSong = HealthReport["songs"][number];
const repairable = (s: HealthSong) => !s.repairing && !s.repaired && s.issues.some((i) => REPAIRABLE.includes(i.code));

/** Voce dei Settaggi (solo nell'app sul PC): apre l'elenco dei brani con problemi. */
export function HealthSetting({ onError }: { onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="setting">
      <div className="setting-title">Brani con problemi</div>
      <p className="setting-desc">
        Testo fuori tempo o mancante, note dell'intonazione mancanti, importazioni non riuscite: per sistemarli o reimportarli.
      </p>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        <Stethoscope size={15} /> Controlla la libreria
      </button>
      {open && createPortal(<HealthDialog onClose={() => setOpen(false)} onError={onError} />, document.body)}
    </div>
  );
}

function HealthDialog({ onClose, onError }: { onClose: () => void; onError: (m: string) => void }) {
  const [r, setR] = useState<HealthReport | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [busy, setBusy] = useState("");
  const [lyricsFor, setLyricsFor] = useState<Song | null>(null);
  const [editing, setEditing] = useState<Song | null>(null);
  const load = useCallback(() => {
    api.songs().then(setSongs).catch(() => {});
    return api.health().then(setR).catch((e) => onError(e.message));
  }, [onError]);
  useEffect(() => {
    load();
  }, [load]);
  // mentre si riparano i brani l'elenco si aggiorna da solo
  const working = (r?.repairing ?? 0) > 0;
  useEffect(() => {
    if (!working) return;
    const t = window.setInterval(() => api.health().then(setR).catch(() => {}), 3000);
    return () => window.clearInterval(t);
  }, [working]);
  const toRepair = r ? r.songs.filter(repairable).map((s) => s.id) : [];

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
  const songOf = (id: string) => songs.find((s) => s.id === id) ?? null;

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal storage-modal health-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Brani con problemi</h3>
          <button type="button" className="icon-btn" title="Chiudi" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {!r ? (
          <Loader2 className="spin" />
        ) : r.songs.length === 0 ? (
          <p className="muted">Nessun problema: tutti i {r.total} brani della libreria sono a posto. 🎉</p>
        ) : (
          <>
            <div className="storage-totals">
              <div>
                <b>{r.count.error}</b> da sistemare
              </div>
              <div>
                <b>{r.count.warn}</b> da controllare
              </div>
              <div>
                <b>{r.count.info}</b> da sapere
              </div>
              <div>
                <b>{r.total}</b> brani in libreria
              </div>
            </div>
            {toRepair.length > 0 && (
              <div className="health-repair-all">
                <p>
                  <b>Testo fuori tempo?</b> «Ripara» riascolta tutta la voce del brano e rifà la sincronizzazione: di solito basta
                  (circa mezzo minuto a brano, in sottofondo).
                </p>
                <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => run("all", () => api.healthRepair(toRepair).then(setR))}>
                  <Wand2 size={15} /> Ripara tutti ({toRepair.length})
                </button>
              </div>
            )}
            <p className="storage-note">
              Se dopo «Ripara» il testo è ancora fuori tempo: «Risincronizza» (cerca di nuovo il testo, magari con artista e titolo
              corretti), oppure correggi il testo a mano; se non migliora, reimporta il brano da un altro video.
            </p>
            <ol className="health-list">
              {r.songs.map((s) => {
                const song = songOf(s.id);
                const ready = s.status === "ready";
                const fixable = s.issues.some((i) => i.code === "import" || i.code === "files" || i.code === "pitch");
                return (
                  <li key={s.id}>
                    {s.thumbnail_url ? <img src={s.thumbnail_url} alt="" /> : <div className="health-noimg" />}
                    <div className="health-body">
                      <b className="ellipsis">{s.title}</b>
                      <span className="muted ellipsis">{s.artist}</span>
                      <ul>
                        {s.repairing && (
                          <li className="health-issue repairing">
                            {s.queued === 0 ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
                            <span>{s.queued === 0 ? "Riparo il testo: ascolto la voce e risincronizzo…" : "In coda per la riparazione"}</span>
                          </li>
                        )}
                        {s.issues.map((i) => (
                          <li key={i.code} className={`health-issue ${i.level}`}>
                            <AlertTriangle size={14} />
                            <span>
                              <em>{LEVEL_LABEL[i.level]}:</em> {i.text}
                            </span>
                            <button
                              className="icon-btn"
                              title="Ignora questo problema (finché il brano non cambia)"
                              disabled={!!busy}
                              onClick={() => run(`${s.id}:${i.code}`, () => api.healthIgnore(s.id, i.code).then(setR))}
                            >
                              <EyeOff size={14} />
                            </button>
                          </li>
                        ))}
                        {s.repaired && s.issues.some((i) => REPAIRABLE.includes(i.code)) && (
                          <li className="health-issue hint">
                            <span>Già riparato una volta: il testo va corretto a mano, oppure va reimportato il brano da un altro video.</span>
                          </li>
                        )}
                      </ul>
                    </div>
                    <div className="health-actions">
                      {repairable(s) && (
                        <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => run(`rep:${s.id}`, () => api.healthRepair([s.id]).then(setR))}>
                          <Wand2 size={14} /> Ripara
                        </button>
                      )}
                      {ready && song && !s.repairing && (
                        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => setEditing(song)}>
                          <RefreshCw size={14} /> Risincronizza
                        </button>
                      )}
                      {ready && song && !s.repairing && (
                        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => setLyricsFor(song)}>
                          <Pencil size={14} /> Correggi il testo
                        </button>
                      )}
                      {fixable && (
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={!!busy}
                          onClick={() => run(s.id, () => api.retry(s.id))}
                          title="Scarica e prepara di nuovo il brano"
                        >
                          {busy === s.id ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Reimporta
                        </button>
                      )}
                      <button
                        className="icon-btn danger"
                        title="Elimina il brano dalla libreria"
                        disabled={!!busy || s.repairing}
                        onClick={() => {
                          if (!confirm(`Eliminare «${s.title}» dalla libreria?`)) return;
                          run(`del:${s.id}`, () => api.deleteSong(s.id));
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
      {editing && (
        <div onClick={(e) => e.stopPropagation()}>
          <EditDialog
            song={editing}
            onClose={() => (setEditing(null), load())}
            onToast={onError}
            onEditLyrics={() => (setLyricsFor(editing), setEditing(null))}
          />
        </div>
      )}
      {lyricsFor && (
        <div onClick={(e) => e.stopPropagation()}>
          <LyricsDialog song={lyricsFor} onClose={() => (setLyricsFor(null), load())} onToast={onError} />
        </div>
      )}
    </div>
  );
}
