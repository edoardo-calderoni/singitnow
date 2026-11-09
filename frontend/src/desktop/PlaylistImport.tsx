import { ListPlus, Loader2, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { fmtTime } from "../shared/api";
import { usePlaylistImport } from "../shared/ytPlaylist";

/**
 * Importazione di una playlist di YouTube dal pannello «Aggiungi brano»: elenco dei brani con le
 * caselle (di partenza quelli non ancora in libreria), «Importa N brani» e, volendo, anche in coda
 * nella playlist della serata. Artista e titolo si ricavano dal titolo di ciascun video.
 */
export function PlaylistImportDialog({
  url,
  onClose,
  onToast,
}: {
  url: string;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const imp = usePlaylistImport(url);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const n = imp.picked.size;
  const go = async () => {
    try {
      const added = await imp.run();
      onToast(
        `${added} brani in importazione${imp.queue ? ", entrano in playlist quando sono pronti" : ""}: li trovi nella libreria.`,
      );
      onClose();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    }
  };

  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div className="modal plimport-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 className="ellipsis">{imp.pl ? imp.pl.title : "Playlist di YouTube"}</h3>
          <button type="button" className="icon-btn" title="Chiudi" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {imp.error && <p className="muted">{imp.error}</p>}
        {!imp.pl && !imp.error && (
          <p className="muted">
            <Loader2 size={16} className="spin" /> Leggo la playlist…
          </p>
        )}
        {imp.pl && (
          <>
            <div className="plimport-bar">
              <span className="muted">
                {imp.pl.entries.length} brani · {n} scelti
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => imp.all(n < imp.pl!.entries.length)}>
                {n < imp.pl.entries.length ? "Scegli tutti" : "Togli tutti"}
              </button>
            </div>
            <ol className="plimport-list">
              {imp.pl.entries.map((e) => (
                <li key={e.youtube_id}>
                  <label>
                    <input type="checkbox" checked={imp.picked.has(e.youtube_id)} onChange={() => imp.toggle(e.youtube_id)} />
                    <img src={e.thumbnail} alt="" loading="lazy" />
                    <span className="plimport-title">
                      <b className="ellipsis">{e.title}</b>
                      <span className="muted ellipsis">
                        {e.channel}
                        {e.duration ? ` · ${fmtTime(e.duration)}` : ""}
                        {e.in_library === "ready" ? " · già in libreria" : e.in_library ? " · in preparazione" : ""}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ol>
            <label className="plimport-queue">
              <input type="checkbox" checked={imp.queue} onChange={(e) => imp.setQueue(e.target.checked)} /> Mettili anche
              nella playlist della serata (entrano quando sono pronti)
            </label>
            <div className="actions">
              <button className="btn btn-ghost" onClick={onClose}>
                Annulla
              </button>
              <button className="btn btn-primary" disabled={!n || imp.busy} onClick={go}>
                {imp.busy ? <Loader2 size={16} className="spin" /> : <ListPlus size={16} />} Importa {n}{" "}
                {n === 1 ? "brano" : "brani"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
