import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Avatar } from "../shared/Avatar";
import { api, LANGUAGES, Song } from "../shared/api";

/**
 * Karaoke: chi canta il brano aggiunto dal PC. Si cerca tra gli utenti collegati dal telefono
 * (o si scrive un nome); il campo può restare vuoto.
 */
export function SingerDialog({
  song,
  onCancel,
  onConfirm,
}: {
  song: Song;
  onCancel: () => void;
  onConfirm: (singer: string) => void;
}) {
  const [name, setName] = useState("");
  const [users, setUsers] = useState<string[] | null>(null);
  // elenco aggiornato mentre il riquadro è aperto (qualcuno può entrare o uscire)
  useEffect(() => {
    let alive = true;
    const load = () => api.users().then((r) => alive && setUsers(r.users)).catch(() => alive && setUsers([]));
    load();
    const id = window.setInterval(load, 3000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  const q = name.trim().toLowerCase();
  const shown = (users ?? []).filter((u) => u.toLowerCase().includes(q));
  return (
    <div className="modal-back" onClick={onCancel}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(name.trim());
        }}
      >
        <h3>Chi canta?</h3>
        <p className="muted" style={{ margin: 0 }}>
          {song.title} · {song.artist}
        </p>
        <div className="field">
          <Search size={18} />
          <input
            autoFocus
            placeholder="Cerca tra gli utenti collegati (facoltativo)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
          />
        </div>
        <div className="singer-list">
          {users === null ? (
            <div className="muted">Carico gli utenti collegati…</div>
          ) : shown.length ? (
            shown.map((u) => (
              <button type="button" key={u} className="singer-pick" onClick={() => onConfirm(u)}>
                <Avatar name={u} className="xs" /> {u}
              </button>
            ))
          ) : (
            <div className="muted">
              {users.length ? "Nessun utente collegato con questo nome." : "Nessun utente collegato dal telefono."}
            </div>
          )}
        </div>
        <p className="muted singer-hint">Se lasci vuoto, il brano viene aggiunto senza nome.</p>
        <div className="actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Annulla
          </button>
          <button className="btn btn-primary">Aggiungi</button>
        </div>
      </form>
    </div>
  );
}

export function EditDialog({ song, onClose, onToast }: { song: Song; onClose: () => void; onToast: (m: string) => void }) {
  const [artist, setArtist] = useState(song.artist);
  const [title, setTitle] = useState(song.title);
  const [language, setLanguage] = useState(song.language);
  const [busy, setBusy] = useState(false);

  const save = async (resync: boolean) => {
    setBusy(true);
    try {
      await api.patchSong(song.id, { artist, title, language });
      if (resync) {
        await api.resync(song.id, artist, title);
        onToast("Rigenero il testo con i nuovi dati…");
      }
      onClose();
    } catch (e: any) {
      onToast(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Modifica brano</h3>
        <label>
          Artista
          <div className="field">
            <input value={artist} onChange={(e) => setArtist(e.target.value)} />
          </div>
        </label>
        <label>
          Titolo
          <div className="field">
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        </label>
        <label>
          Lingua
          <div className="field">
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              {!LANGUAGES[language] && <option value={language}>{language ? language.toUpperCase() : "Non riconosciuta"}</option>}
              {Object.entries(LANGUAGES).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </label>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Se il testo è sbagliato o mancante, correggi artista e titolo e rigenera: verrà cercato di nuovo online e
          risincronizzato con la voce.
        </p>
        <div className="actions">
          <button className="btn btn-ghost" disabled={busy} onClick={() => save(false)}>
            Salva
          </button>
          <button className="btn btn-primary" disabled={busy || song.status !== "ready"} onClick={() => save(true)}>
            Salva e rigenera testo
          </button>
        </div>
      </div>
    </div>
  );
}
