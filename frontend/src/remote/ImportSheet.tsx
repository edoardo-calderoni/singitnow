import { useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Mic2, Music } from "lucide-react";
import { SearchResult } from "../shared/api";
import { useImportNames } from "../shared/importNames";

/**
 * Conferma di artista e titolo prima di importare un video di YouTube dal telefono: partono dai dati
 * del video e si possono correggere (servono a trovare il testo giusto; i refusi li corregge il PC).
 */
export function ImportSheet({
  result,
  onCancel,
  onConfirm,
}: {
  result: SearchResult;
  onCancel: () => void;
  onConfirm: (artist: string, title: string) => Promise<void>;
}) {
  const n = useImportNames(result);
  const [busy, setBusy] = useState(false);
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!n.ready || busy) return;
    setBusy(true);
    try {
      await onConfirm(n.artist.trim(), n.title.trim());
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className="m-sheet" onClick={onCancel}>
      <form
        className="m-sheet-card m-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="m-import-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="m-sheet-title" id="m-import-title">
          Conferma artista e titolo
        </div>
        <div className="m-import-video">
          <img src={result.thumbnail} alt="" />
          <div className="m-import-video-title">{result.title}</div>
        </div>
        <label className="m-import-label">
          Artista
          <div className="field">
            <Mic2 size={18} />
            <input value={n.artist} onChange={(e) => n.setArtist(e.target.value)} disabled={n.loading} />
          </div>
        </label>
        <label className="m-import-label">
          Titolo della canzone
          <div className="field">
            <Music size={18} />
            <input value={n.title} onChange={(e) => n.setTitle(e.target.value)} disabled={n.loading} />
          </div>
        </label>
        <div className="m-import-hint">Controlla che siano giusti: servono a trovare il testo della canzone.</div>
        <div className="m-sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Annulla
          </button>
          <button type="submit" className="btn btn-primary" disabled={!n.ready || busy}>
            {busy || n.loading ? <Loader2 size={18} className="spin" /> : "Conferma"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
