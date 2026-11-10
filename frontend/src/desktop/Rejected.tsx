import { AlertTriangle, Search, X } from "lucide-react";
import { ImportRejected } from "../shared/api";

/** Brano importato ma inutilizzabile (testo fuori tempo o non trovato, melodia mancante): è già stato
 * cancellato, si propone di cercare un altro video della stessa canzone. */
export function RejectedDialog({
  data,
  onClose,
  onSearch,
}: {
  data: ImportRejected;
  onClose: () => void;
  onSearch: (query: string) => void;
}) {
  const s = data.song;
  const query = [s.artist, s.title].filter(Boolean).join(" ");
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal rejected-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>
            <AlertTriangle size={18} /> Importazione non riuscita
          </h3>
          <button type="button" className="icon-btn" title="Chiudi" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="rejected-song">
          {s.thumbnail_url ? <img src={s.thumbnail_url} alt="" /> : <div className="rejected-noimg" />}
          <div>
            <b className="ellipsis">{s.title}</b>
            <span className="muted ellipsis">{s.artist}</span>
          </div>
        </div>
        <p>
          Non è stato possibile importare questo video: {data.reason}. Il brano non è stato aggiunto alla libreria
          {data.singers.length ? ` (né alla playlist di ${data.singers.join(", ")})` : ""}.
        </p>
        <p className="muted">Scegli un altro video per la stessa canzone, meglio se la versione ufficiale.</p>
        <div className="rejected-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Chiudi
          </button>
          <button className="btn btn-primary" onClick={() => onSearch(query)}>
            <Search size={16} /> Scegli un altro video
          </button>
        </div>
      </div>
    </div>
  );
}
