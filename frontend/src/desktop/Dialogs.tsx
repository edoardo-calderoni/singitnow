import { useEffect, useState } from "react";
import { FileText, Loader2, Search, X } from "lucide-react";
import { Avatar } from "../shared/Avatar";
import { api, LANGUAGES, SearchResult, Song } from "../shared/api";
import { useImportNames } from "../shared/importNames";
import { useCompetition } from "../shared/competition";

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
  // con la competizione accesa il voto va a qualcuno: bisogna dire chi canta
  const required = useCompetition().enabled;
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
  // competizione: con utenti collegati si sceglie uno di loro; senza, si può scrivere un nome
  const picked = (users ?? []).find((u) => u.toLowerCase() === q);
  const freeName = !users?.length;
  const valid = !required || (freeName ? !!q : !!picked);
  const confirmName = picked ?? name.trim();
  return (
    <div className="modal-back" onClick={onCancel}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onConfirm(confirmName);
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
            placeholder={
              !required
                ? "Cerca tra gli utenti collegati (facoltativo)"
                : freeName
                  ? "Scrivi il nome di chi canta"
                  : "Cerca tra gli utenti collegati"
            }
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
        <p className="muted singer-hint">
          {!required
            ? "Se lasci vuoto, il brano viene aggiunto senza nome."
            : freeName
              ? "Competizione accesa: nessun utente collegato, scrivi il nome di chi canta così il voto entra in classifica."
              : "Competizione accesa: scegli chi canta tra gli utenti collegati, così il voto entra in classifica."}
        </p>
        <div className="actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Annulla
          </button>
          <button className="btn btn-primary" disabled={!valid}>
            Aggiungi
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Testo del brano corretto a mano: una riga per ogni riga del karaoke. Salvando, le parole
 * vengono risincronizzate con la voce (non serve scrivere i tempi).
 */
export function LyricsDialog({ song, onClose, onToast }: { song: Song; onClose: () => void; onToast: (m: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [original, setOriginal] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .lyrics(song.id)
      .then((l) => l.lines.map((x) => x.orig ?? x.text).join("\n"))
      .catch(() => "") // nessun testo: si può scrivere da zero
      .then((t) => (setOriginal(t), setText(t)));
  }, [song.id]);
  const lines = (text ?? "").split("\n").filter((l) => l.trim()).length;
  const changed = text !== null && text.trim() !== original.trim();

  const save = async () => {
    if (!text?.trim()) return;
    setBusy(true);
    try {
      await api.setLyrics(song.id, text);
      onToast("Sincronizzo il testo corretto con la voce…");
      onClose();
    } catch (e: any) {
      onToast(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal modal-lyrics" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Modifica testo</h3>
          <button type="button" className="icon-btn" title="Chiudi" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {song.title} · {song.artist}
        </p>
        {text === null ? (
          <div className="lyrics-loading">
            <Loader2 size={18} className="spin" /> Carico il testo…
          </div>
        ) : (
          <textarea
            className="lyrics-edit"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Scrivi o incolla il testo, una riga per ogni riga da cantare"
            spellCheck={false}
            autoFocus
          />
        )}
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Una riga per ogni riga che compare sullo schermo; le righe vuote vengono ignorate. Salvando, le parole
          vengono rimesse a tempo con la voce del brano: ci vuole qualche decina di secondi.
          {text !== null && ` · ${lines} ${lines === 1 ? "riga" : "righe"}`}
        </p>
        <div className="actions">
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
            Annulla
          </button>
          <button className="btn btn-primary" disabled={busy || !changed || !lines || song.status !== "ready"} onClick={save}>
            {busy && <Loader2 size={16} className="spin" />} Salva e sincronizza
          </button>
        </div>
      </div>
    </div>
  );
}

export function EditDialog({
  song,
  onClose,
  onToast,
  onEditLyrics,
}: {
  song: Song;
  onClose: () => void;
  onToast: (m: string) => void;
  onEditLyrics: () => void;
}) {
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
      <div className="modal modal-edit" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Modifica brano</h3>
          <button type="button" className="icon-btn" title="Chiudi" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
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
          risincronizzato con la voce. Oppure correggilo tu con «Modifica testo».
        </p>
        {/* una sola riga: «Modifica testo» a sinistra, i salvataggi a destra */}
        <div className="actions">
          <button
            type="button"
            className="btn btn-ghost edit-lyrics-btn"
            disabled={busy || song.status !== "ready"}
            onClick={onEditLyrics}
          >
            <FileText size={16} /> Modifica testo
          </button>
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

/**
 * Conferma di artista e titolo prima di importare un video di YouTube: partono dai dati del video e
 * si possono correggere. Sono quelli con cui si cerca il testo e che finiscono in libreria.
 */
export function ImportDialog({
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
  return (
    <div className="modal-back" onClick={onCancel}>
      <form className="modal modal-edit modal-import" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>Conferma artista e titolo</h3>
          <button type="button" className="icon-btn" title="Chiudi" onClick={onCancel}>
            <X size={18} />
          </button>
        </div>
        <div className="import-video">
          <img src={result.thumbnail} alt="" />
          <div>
            <div className="import-video-title">{result.title}</div>
            <div className="muted">{result.channel}</div>
          </div>
        </div>
        <label>
          Artista
          <div className="field">
            <input value={n.artist} onChange={(e) => n.setArtist(e.target.value)} disabled={n.loading} autoFocus />
          </div>
        </label>
        <label>
          Titolo della canzone
          <div className="field">
            <input value={n.title} onChange={(e) => n.setTitle(e.target.value)} disabled={n.loading} />
          </div>
        </label>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Controlla che siano giusti: servono a trovare il testo della canzone. Eventuali errori di battitura vengono
          corretti confrontandoli con il titolo del video.
        </p>
        <div className="actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Annulla
          </button>
          <button type="submit" className="btn btn-primary" disabled={!n.ready || busy}>
            {busy || n.loading ? <Loader2 size={16} className="spin" /> : null} Conferma e importa
          </button>
        </div>
      </form>
    </div>
  );
}
