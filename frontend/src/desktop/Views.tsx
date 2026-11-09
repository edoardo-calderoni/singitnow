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
  ChevronDown,
  X,
} from "lucide-react";
import {
  api,
  filterSongs,
  fmtEta,
  fmtTime,
  youtubeId,
  LANGUAGES,
  languageLabel,
  PlaylistState,
  SearchResult,
  Song,
} from "../shared/api";
import { Avatar } from "../shared/Avatar";
import { ImportDialog } from "./Dialogs";
import { useYoutubeSearch } from "../shared/search";
import { openExternal } from "../shared/external";

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
  waiting,
  onCancelWaiting,
  onPlay,
  onQueue,
  onEdit,
  onToast,
  goSearch,
}: {
  songs: Song[];
  waiting: PlaylistState["waiting"]; // prenotazioni di brani in preparazione (fuori dalla playlist)
  onCancelWaiting: (songId: string, singer: string) => void;
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
    const preparing = s.status !== "ready" && s.status !== "error";
    const ask = preparing
      ? `Interrompere l'importazione di "${s.title}"? Il brano verrà cancellato.`
      : `Eliminare "${s.title}" dalla libreria?`;
    if (!confirm(ask)) return;
    try {
      await api.deleteSong(s.id);
    } catch (e: any) {
      onToast(e.message);
    }
  };

  return (
    <section className="view view-fixed">
      <header className="view-head">
        <div>
          <h1>Libreria</h1>
          <p className="muted">
            {ready} {ready === 1 ? "brano pronto" : "brani pronti"}
            {songs.length > ready && ` · ${songs.length - ready} in elaborazione`}
          </p>
        </div>
        <button className="btn btn-primary" onClick={goSearch}>
          <Plus size={18} /> Nuovo brano
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

      {/* scorre solo la lista: titolo, ricerca e filtro restano fermi in alto */}
      <div className="view-scroll">
      {songs.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">
            <Mic2 size={34} />
          </div>
          <h3>La libreria è vuota</h3>
          <p>Cerca il primo brano su YouTube: lo scarichiamo e prepariamo base e testo in automatico.</p>
          <button className="btn btn-primary" onClick={goSearch}>
            <Plus size={18} /> Nuovo brano
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
                </div>
                <div className="song-sub song-info">
                  <span className="song-duration">
                    <span className="song-duration-label">Durata</span>
                    {fmtTime(s.duration)}
                  </span>
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
                {/* chi l'ha prenotato: entra in playlist appena pronto, qui si può annullare */}
                {s.status !== "ready" && waiting.some((w) => w.song_id === s.id) && (
                  <div className="song-waiting">
                    <span className="muted">In playlist appena pronto:</span>
                    {waiting
                      .filter((w) => w.song_id === s.id)
                      .map((w, i) => (
                        <span key={i} className="song-waiting-chip">
                          {w.singer ? <Avatar name={w.singer} className="xs" /> : null}
                          <span>{w.singer || "senza nome"}</span>
                          <button
                            className="icon-btn danger"
                            title="Annulla la prenotazione"
                            onClick={() => onCancelWaiting(s.id, w.singer)}
                          >
                            <X size={14} />
                          </button>
                        </span>
                      ))}
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
                  title={s.status !== "ready" && s.status !== "error" ? "Interrompi l'importazione e cancella" : "Elimina"}
                  onClick={() => remove(s)}
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      </div>
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
  const search = useYoutubeSearch(onToast);
  const { results, busy } = search;
  const byId = useMemo(() => new Map(songs.map((s) => [s.id, s])), [songs]);

  const run = (e?: React.FormEvent, text = q) => {
    e?.preventDefault();
    search.run(text);
  };

  // prima di importare si confermano artista e titolo (servono a trovare il testo giusto)
  const [importing, setImporting] = useState<SearchResult | null>(null);
  const add = (r: SearchResult) => setImporting(r);
  const confirmImport = async (artist: string, title: string) => {
    const r = importing!;
    try {
      const song = await api.download(r, "", artist, title);
      setImporting(null);
      onToast(`Aggiunto «${song.title}» di ${song.artist}: lo sto preparando in background.`);
    } catch (err: any) {
      onToast(err.message);
    }
  };

  return (
    <section className="view view-fixed">
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
          <input
            autoFocus
            placeholder="Artista e titolo, es. «Måneskin Zitti e buoni», oppure incolla il link di YouTube"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              // link incollato: si cerca subito quel video, senza premere Cerca
              const id = youtubeId(e.target.value);
              if (id && id !== youtubeId(q)) run(undefined, e.target.value);
            }}
          />
        </div>
        <button className="btn btn-primary btn-lg" disabled={busy || !q.trim()}>
          {busy ? <Loader2 size={18} className="spin" /> : <Search size={18} />} Cerca
        </button>
      </form>

      <div className="view-scroll">
      {results === null ? (
        <div className="empty">
          <div className="empty-icon">
            <MonitorPlay size={34} />
          </div>
          <h3>Trova la tua canzone</h3>
          <p>Suggerimento: Aggiungi video-clip che NON CONTENGONO IL TESTO DELLA CANZONE e se possibile ORIGINALI.</p>
          <p>Hai già il video? Incolla il suo link di YouTube nel campo di ricerca.</p>
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
                {/* la copertina apre il video su YouTube, per controllarlo prima di aggiungerlo */}
                <button
                  type="button"
                  className="cover song-cover yt-preview"
                  title="Guarda il video su YouTube"
                  onClick={() => openExternal(r.url)}
                >
                  <img src={r.thumbnail} alt="" loading="lazy" />
                  <span className="yt-play">
                    <Play size={18} fill="currentColor" />
                  </span>
                </button>
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
      {results && results.length > 0 && search.canMore && (
        <div className="load-more">
          <button className="btn btn-ghost" onClick={search.loadMore} disabled={search.loadingMore}>
            {search.loadingMore ? <Loader2 size={16} className="spin" /> : <ChevronDown size={16} />} Carica altri risultati
          </button>
        </div>
      )}
      </div>
      {importing && <ImportDialog result={importing} onCancel={() => setImporting(null)} onConfirm={confirmImport} />}
    </section>
  );
}
