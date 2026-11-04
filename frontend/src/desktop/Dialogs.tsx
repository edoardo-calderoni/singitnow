import { useState } from "react";
import { api, LANGUAGES, Song } from "../shared/api";

export function SingerDialog({
  song,
  recent,
  onCancel,
  onConfirm,
}: {
  song: Song;
  recent: string[];
  onCancel: () => void;
  onConfirm: (singer: string) => void;
}) {
  const [name, setName] = useState("");
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
          <input autoFocus placeholder="Nome del cantante" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </div>
        {recent.length > 0 && (
          <div className="chips">
            {recent.map((r) => (
              <button type="button" key={r} className="chip" onClick={() => onConfirm(r)}>
                {r}
              </button>
            ))}
          </div>
        )}
        <div className="actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Annulla
          </button>
          <button className="btn btn-primary">Aggiungi alla coda</button>
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
