import { ListPlus, Loader2, X } from "lucide-react";
import { usePlaylistImport } from "../shared/ytPlaylist";

/**
 * Amministratori: importazione di una playlist di YouTube dal telefono (link incollato nella
 * ricerca). Si scelgono i brani e, volendo, li si mette in coda con il proprio nome.
 */
export function PlaylistImportSheet({
  url,
  name,
  onClose,
  onDone,
}: {
  url: string;
  name: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const imp = usePlaylistImport(url);
  const n = imp.picked.size;
  const go = async () => {
    try {
      const added = await imp.run(name);
      onDone(`${added} brani in importazione${imp.queue ? ", entrano in playlist quando sono pronti" : ""}`);
      onClose();
    } catch (e) {
      onDone(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="m-sheet" onClick={onClose}>
      <div className="m-sheet-card m-plimport" onClick={(e) => e.stopPropagation()}>
        <div className="m-stats-head">
          <div className="m-sheet-title ellipsis">{imp.pl?.title ?? "Playlist di YouTube"}</div>
          <button type="button" className="icon-btn" title="Chiudi" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {imp.error && <div className="m-vote-note err">{imp.error}</div>}
        {!imp.pl && !imp.error && <Loader2 className="spin" />}
        {imp.pl && (
          <>
            <div className="m-plimport-bar">
              <span className="muted">
                {imp.pl.entries.length} brani · {n} scelti
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => imp.all(n < imp.pl!.entries.length)}>
                {n < imp.pl.entries.length ? "Tutti" : "Nessuno"}
              </button>
            </div>
            <ol className="m-plimport-list">
              {imp.pl.entries.map((e) => (
                <li key={e.youtube_id}>
                  <label>
                    <input type="checkbox" checked={imp.picked.has(e.youtube_id)} onChange={() => imp.toggle(e.youtube_id)} />
                    <span className="ellipsis">
                      <b>{e.title}</b>
                      {e.in_library === "ready" && <span className="muted"> · già in libreria</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ol>
            <label className="m-plimport-queue">
              <input type="checkbox" checked={imp.queue} onChange={(e) => imp.setQueue(e.target.checked)} /> Mettili anche in
              playlist con il tuo nome
            </label>
            <button type="button" className="btn btn-primary btn-wide" disabled={!n || imp.busy} onClick={go}>
              {imp.busy ? <Loader2 size={16} className="spin" /> : <ListPlus size={16} />} Importa {n}{" "}
              {n === 1 ? "brano" : "brani"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
