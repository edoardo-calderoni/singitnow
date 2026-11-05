import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  Mic2,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Trash2,
  MonitorPlay,
  Plus,
  ArrowLeft,
} from "lucide-react";
import { api, filterSongs, fmtEta, fmtTime, LANGUAGES, languageLabel, SearchResult, Song } from "../shared/api";

function StatusBadge({ song }: { song: Song }) {
  if (song.status === "ready") return null;
  if (song.status === "error")
    return (
      <span className="badge err" title={song.error}>
        <AlertTriangle size={12} /> Errore
      </span>
    );
  return (
    <span className="badge work">
      <Loader2 size={12} className="spin" /> {Math.round(song.progress * 100)}%
    </span>
  );
}

// ------------------------------------------------------------------ Libreria
export function LibraryView({
  songs,
  onPlay,
  onQueue,
  onEdit,
  onToast,
  goSearch,
}: {
  songs: Song[];
  onPlay: (s: Song) => void;
  onQueue: (s: Song) => void;
  onEdit: (s: Song) => void;
  onToast: (m: string) => void;
  goSearch: () => void;
}) {
  const [text, setText] = useState("");
  const [lang, setLang] = useState("");
  const shown = useMemo(() => filterSongs(songs, text, lang), [songs, text, lang]);
  const ready = songs.filter((s) => s.status === "ready").length;

  const remove = async (s: Song) => {
    if (!confirm(`Eliminare "${s.title}" dalla libreria?`)) return;
    try {
      await api.deleteSong(s.id);
    } catch (e: any) {
      onToast(e.message);
    }
  };

  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Libreria</h1>
          <p className="muted">
            {ready} {ready === 1 ? "brano pronto" : "brani pronti"}
            {songs.length > ready && ` · ${songs.length - ready} in elaborazione`}
          </p>
        </div>
        <button className="btn btn-primary" onClick={goSearch}>
          <Plus size={18} /> Aggiungi brano
        </button>
      </header>

      <div className="toolbar">
        <div className="field grow">
          <Search size={20} />
          <input placeholder="Cerca per titolo o artista…" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="field select">
          <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Lingua">
            <option value="">Tutte le lingue</option>
            {Object.entries(LANGUAGES).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {songs.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">
            <Mic2 size={34} />
          </div>
          <h3>La libreria è vuota</h3>
          <p>Cerca il primo brano su YouTube: lo scarichiamo e prepariamo base e testo in automatico.</p>
          <button className="btn btn-primary" onClick={goSearch}>
            <Plus size={18} /> Aggiungi brano
          </button>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <h3>Nessun brano trovato</h3>
          <p>Prova a cambiare la ricerca o la lingua.</p>
        </div>
      ) : (
        <ul className="song-list">
          {shown.map((s) => (
            <li key={s.id} className={`song-row status-${s.status}`}>
              <div className="cover song-cover">
                <img src={s.thumbnail_url} alt="" loading="lazy" />
                {s.status === "ready" && (
                  <button className="cover-play" title="Canta ora" onClick={() => onPlay(s)}>
                    <Play size={26} fill="currentColor" />
                  </button>
                )}
              </div>
              <div className="song-main">
                <div className="song-title ellipsis">{s.title}</div>
                <div className="song-sub">
                  <span className="song-artist ellipsis">{s.artist || "Artista sconosciuto"}</span>
                  <span className="song-duration">{fmtTime(s.duration)}</span>
                  {s.language && <span className="badge lang">{languageLabel(s.language)}</span>}
                  {s.lyrics_source === "none" && <span className="badge err">Senza testo</span>}
                </div>
                {s.status !== "ready" && s.status !== "error" && (
                  <div className="song-progress">
                    <div className="progress">
                      <div style={{ width: `${s.progress * 100}%` }} />
                    </div>
                    <span>{s.step}</span>
                    {fmtEta(s) && <span className="song-eta">{fmtEta(s)}</span>}
                  </div>
                )}
                {s.status === "error" && <div className="song-error ellipsis">{s.error}</div>}
              </div>
              <div className="song-meta">
                <StatusBadge song={s} />
              </div>
              <div className="song-actions">
                {s.status === "ready" && (
                  <>
                    <button className="btn btn-primary btn-sm" onClick={() => onQueue(s)}>
                      <Play size={15} fill="currentColor" /> Aggiungi
                    </button>
                  </>
                )}
                {s.status === "error" && (
                  <button className="btn btn-ghost btn-sm" onClick={() => api.retry(s.id)}>
                    <RefreshCw size={15} /> Riprova
                  </button>
                )}
                <button className="icon-btn" title="Modifica / correggi testo" onClick={() => onEdit(s)}>
                  <Pencil size={18} />
                </button>
                <button
                  className="icon-btn danger"
                  title="Elimina"
                  disabled={s.status !== "ready" && s.status !== "error"}
                  onClick={() => remove(s)}
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ Ricerca YouTube
export function SearchView({
  songs,
  onToast,
  onBack,
}: {
  songs: Song[];
  onToast: (m: string) => void;
  onBack: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map(songs.map((s) => [s.id, s])), [songs]);

  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    try {
      setResults(await api.search(q));
    } catch (err: any) {
      onToast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const add = async (r: SearchResult) => {
    try {
      await api.download(r);
      onToast("Aggiunto! Lo sto preparando in background.");
    } catch (err: any) {
      onToast(err.message);
    }
  };

  return (
    <section className="view">
      <header className="view-head">
        <div>
          <button className="btn btn-ghost btn-sm back-btn" onClick={onBack}>
            <ArrowLeft size={16} /> Libreria
          </button>
          <h1>Aggiungi brano</h1>
          <p className="muted">Scegli video ufficiali senza testo della canzone.</p>
        </div>
      </header>
      <form className="toolbar" onSubmit={run}>
        <div className="field field-lg grow">
          <MonitorPlay size={22} />
          <input autoFocus placeholder="Artista e titolo, es. «Måneskin Zitti e buoni»" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn btn-primary btn-lg" disabled={busy || !q.trim()}>
          {busy ? <Loader2 size={18} className="spin" /> : <Search size={18} />} Cerca
        </button>
      </form>

      {results === null ? (
        <div className="empty">
          <div className="empty-icon">
            <MonitorPlay size={34} />
          </div>
          <h3>Trova la tua canzone</h3>
          <p>Suggerimento: Aggiungi video-clip che NON CONTENGONO IL TESTO DELLA CANZONE e se possibile ORIGINALI.</p>
        </div>
      ) : results.length === 0 ? (
        <div className="empty">
          <h3>Nessun risultato</h3>
        </div>
      ) : (
        <ul className="song-list">
          {results.map((r) => {
            const s = byId.get(r.youtube_id);
            return (
              <li key={r.youtube_id} className="song-row">
                <div className="cover song-cover">
                  <img src={r.thumbnail} alt="" loading="lazy" />
                </div>
                <div className="song-main">
                  <div className="song-title full-title">{r.title}</div>
                  <div className="song-sub">
                    <span className="song-artist ellipsis">{r.channel}</span>
                    <span className="song-duration">{fmtTime(r.duration)}</span>
                  </div>
                </div>
                <div className="song-meta" />
                <div className="song-actions">
                  {s?.status === "ready" ? (
                    <span className="badge ok">
                      <Check size={12} /> In libreria
                    </span>
                  ) : s && s.status !== "error" ? (
                    <span className="badge work">
                      <Loader2 size={12} className="spin" /> {Math.round(s.progress * 100)}%
                      {fmtEta(s) && <> · {fmtEta(s)}</>}
                    </span>
                  ) : (
                    <button className="btn btn-ghost btn-sm" onClick={() => add(r)}>
                      <Download size={15} /> Aggiungi alla libreria
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
