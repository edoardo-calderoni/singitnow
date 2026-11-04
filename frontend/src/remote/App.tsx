import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Library,
  ListMusic,
  Loader2,
  Mic,
  MicOff,
  Pause,
  Play,
  Plus,
  Search,
  Trash2,
  User,
  MonitorPlay,
} from "lucide-react";
import { api, filterSongs, fmtTime, initials, LANGUAGES, languageLabel, SearchResult, Song } from "../shared/api";
import { useLive } from "../shared/live";

type Tab = "queue" | "library" | "search";

export function App() {
  const { songs, playlist, connected } = useLive();
  const [name, setName] = useState(() => localStorage.getItem("sin.name") ?? "");
  const [tab, setTab] = useState<Tab>("queue");
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const safe = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) setToast(ok);
    } catch (e: any) {
      setToast(e.message);
    }
  };

  if (!name) return <Welcome onDone={(n) => (localStorage.setItem("sin.name", n), setName(n))} />;

  const mine = playlist.entries.filter((e) => e.singer === name).length + playlist.waiting.filter((w) => w.singer === name).length;

  return (
    <div className="m-app">
      <header className="m-head">
        <div className="m-brand">
          <img src="/icon.svg" alt="" />
          <span>
            Sing<span className="grad-text">IT</span>now
          </span>
        </div>
        <button
          className="m-user"
          onClick={() => {
            const n = prompt("Il tuo nome", name)?.trim();
            if (n) (localStorage.setItem("sin.name", n), setName(n));
          }}
        >
          <span className="avatar xs">{initials(name)}</span> {name}
        </button>
      </header>
      {!connected && <div className="m-offline">Connessione al PC persa… riprovo</div>}

      <main className="m-main">
        {tab === "queue" && <QueueTab name={name} playlist={playlist} safe={safe} goLibrary={() => setTab("library")} />}
        {tab === "library" && <LibraryTab songs={songs} name={name} safe={safe} />}
        {tab === "search" && <SearchTab songs={songs} name={name} safe={safe} />}
      </main>

      <nav className="m-tabs">
        <button className={tab === "queue" ? "on" : ""} onClick={() => setTab("queue")}>
          <ListMusic size={22} />
          Playlist
          {mine > 0 && <span className="m-dot">{mine}</span>}
        </button>
        <button className={tab === "library" ? "on" : ""} onClick={() => setTab("library")}>
          <Library size={22} />
          Brani
        </button>
        <button className={tab === "search" ? "on" : ""} onClick={() => setTab("search")}>
          <MonitorPlay size={22} />
          YouTube
        </button>
      </nav>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

type Safe = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function Welcome({ onDone }: { onDone: (n: string) => void }) {
  const [n, setN] = useState("");
  return (
    <form
      className="m-welcome"
      onSubmit={(e) => {
        e.preventDefault();
        if (n.trim()) onDone(n.trim());
      }}
    >
      <img src="/icon.svg" alt="" className="m-welcome-logo" />
      <h1>
        Benvenuto su Sing<span className="grad-text">IT</span>now
      </h1>
      <p className="muted">Come ti chiami? Il tuo nome apparirà sulla TV quando sarà il tuo turno.</p>
      <div className="field field-lg">
        <User size={20} />
        <input autoFocus placeholder="Il tuo nome" value={n} onChange={(e) => setN(e.target.value)} maxLength={40} />
      </div>
      <button className="btn btn-primary btn-wide" disabled={!n.trim()}>
        Entra nella festa
      </button>
    </form>
  );
}

// ------------------------------------------------------------------ Playlist
function QueueTab({
  name,
  playlist,
  safe,
  goLibrary,
}: {
  name: string;
  playlist: ReturnType<typeof useLive>["playlist"];
  safe: Safe;
  goLibrary: () => void;
}) {
  const now = playlist.now_playing;
  const [guide, setGuide] = useState(false);
  return (
    <div className="m-section">
      {now?.song && (
        <div className="m-now">
          <img className="m-now-bg" src={now.song.thumbnail_url} alt="" />
          <div className="m-now-body">
            <div className="eyebrow">Sul palco{now.singer ? `: ${now.singer}` : ""}</div>
            <div className="m-now-title">{now.song.title}</div>
            <div className="muted">{now.song.artist}</div>
            <div className="m-now-ctrl">
              <button className="btn btn-ghost btn-sm" onClick={() => safe(() => api.command("toggle"))}>
                <Play size={14} />/<Pause size={14} />
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setGuide(!guide);
                  safe(() => api.command("vocals", guide ? 0 : 0.6));
                }}
              >
                {guide ? <MicOff size={14} /> : <Mic size={14} />} {guide ? "Togli voce guida" : "Voce guida"}
              </button>
            </div>
          </div>
        </div>
      )}

      <h2 className="m-h2">Prossimi a cantare</h2>
      {playlist.entries.length === 0 && playlist.waiting.length === 0 ? (
        <div className="empty">
          <h3>La coda è vuota</h3>
          <p>Prenota la tua canzone!</p>
          <button className="btn btn-primary" onClick={goLibrary}>
            <Plus size={18} /> Scegli un brano
          </button>
        </div>
      ) : (
        <ol className="m-list">
          {playlist.entries.map((e, i) => (
            <li key={e.id} className={`m-item ${e.singer === name ? "mine" : ""}`}>
              <div className="m-pos">{i + 1}</div>
              <div className="cover m-cover">
                <img src={e.song?.thumbnail_url} alt="" />
              </div>
              <div className="m-item-main">
                <div className="m-item-title ellipsis">{e.song?.title}</div>
                <div className="m-item-sub ellipsis">
                  <b>{e.singer || "Ospite"}</b> · {fmtTime(e.song?.duration ?? 0)}
                </div>
              </div>
              <div className="m-item-act">
                <button className="icon-btn" disabled={i === 0} onClick={() => safe(() => api.move(e.id, -1))}>
                  <ChevronUp size={18} />
                </button>
                <button
                  className="icon-btn"
                  disabled={i === playlist.entries.length - 1}
                  onClick={() => safe(() => api.move(e.id, 1))}
                >
                  <ChevronDown size={18} />
                </button>
              </div>
              {e.singer === name && (
                <button className="icon-btn danger" onClick={() => safe(() => api.unqueue(e.id), "Prenotazione rimossa")}>
                  <Trash2 size={18} />
                </button>
              )}
            </li>
          ))}
          {playlist.waiting.map((w, i) => (
            <li key={`w${i}`} className={`m-item waiting ${w.singer === name ? "mine" : ""}`}>
              <div className="m-pos">
                <Loader2 size={14} className="spin" />
              </div>
              <div className="cover m-cover">
                <img src={w.song?.thumbnail_url} alt="" />
              </div>
              <div className="m-item-main">
                <div className="m-item-title ellipsis">{w.song?.title}</div>
                <div className="m-item-sub ellipsis">
                  <b>{w.singer}</b> · in preparazione {Math.round((w.song?.progress ?? 0) * 100)}%
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Libreria
function LibraryTab({ songs, name, safe }: { songs: Song[]; name: string; safe: Safe }) {
  const [text, setText] = useState("");
  const [lang, setLang] = useState("");
  const ready = useMemo(() => filterSongs(songs.filter((s) => s.status === "ready"), text, lang), [songs, text, lang]);
  return (
    <div className="m-section">
      <div className="m-filters">
        <div className="field">
          <Search size={18} />
          <input placeholder="Titolo o artista" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="field m-lang">
          <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Lingua">
            <option value="">Tutte</option>
            {Object.entries(LANGUAGES).map(([c, l]) => (
              <option key={c} value={c}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>
      {ready.length === 0 ? (
        <div className="empty">
          <h3>Nessun brano</h3>
          <p>Cerca su YouTube per aggiungerne uno nuovo.</p>
        </div>
      ) : (
        <ul className="m-list">
          {ready.map((s) => (
            <li key={s.id} className="m-item">
              <div className="cover m-cover">
                <img src={s.thumbnail_url} alt="" loading="lazy" />
              </div>
              <div className="m-item-main">
                <div className="m-item-title ellipsis">{s.title}</div>
                <div className="m-item-sub ellipsis">
                  {s.artist} · {fmtTime(s.duration)}
                  {s.language && <span className="badge lang">{languageLabel(s.language)}</span>}
                </div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => safe(() => api.enqueue(s.id, name), "Prenotato! 🎤")}>
                <Plus size={16} /> Canto
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ YouTube
function SearchTab({ songs, name, safe }: { songs: Song[]; name: string; safe: Safe }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map(songs.map((s) => [s.id, s])), [songs]);

  return (
    <div className="m-section">
      <form
        className="m-filters"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!q.trim()) return;
          setBusy(true);
          await safe(async () => setResults(await api.search(q)));
          setBusy(false);
        }}
      >
        <div className="field">
          <MonitorPlay size={18} />
          <input type="search" placeholder="Artista e titolo" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn btn-primary" disabled={busy || !q.trim()}>
          {busy ? <Loader2 size={16} className="spin" /> : <Search size={16} />}
        </button>
      </form>
      {results === null && (
        <div className="empty">
          <h3>Non trovi la tua canzone?</h3>
          <p>Cercala su YouTube: verrà preparata per il karaoke e messa in coda con il tuo nome.</p>
        </div>
      )}
      <ul className="m-list">
        {results?.map((r) => {
          const s = byId.get(r.youtube_id);
          return (
            <li key={r.youtube_id} className="m-item">
              <div className="cover m-cover wide">
                <img src={r.thumbnail} alt="" loading="lazy" />
              </div>
              <div className="m-item-main">
                <div className="m-item-title clamp2">{r.title}</div>
                <div className="m-item-sub ellipsis">
                  {r.channel} · {fmtTime(r.duration)}
                </div>
              </div>
              {s?.status === "ready" ? (
                <button className="btn btn-ghost btn-sm" onClick={() => safe(() => api.enqueue(s.id, name), "Prenotato! 🎤")}>
                  <Check size={16} /> Canto
                </button>
              ) : (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => safe(() => api.download(r, name), "Lo preparo e ti metto in coda!")}
                >
                  <Plus size={16} /> Canto
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
