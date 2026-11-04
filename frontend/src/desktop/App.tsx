import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Library, ListMusic, Play, Smartphone, Trash2, Wifi, WifiOff, MonitorPlay } from "lucide-react";
import { api, Entry, initials, Song } from "../shared/api";
import { useLive } from "../shared/live";
import { EditDialog, SingerDialog } from "./Dialogs";
import { Player } from "./Player";
import { LibraryView, SearchView } from "./Views";

type Tab = "library" | "search";

export function App() {
  const { songs, playlist, connected } = useLive((event, data) => {
    if (event === "player_command") window.dispatchEvent(new CustomEvent("player-command", { detail: data }));
  });
  const [tab, setTab] = useState<Tab>("library");
  const [info, setInfo] = useState<{ remote_url: string; qr_svg: string } | null>(null);
  const [toast, setToast] = useState("");
  const [queueFor, setQueueFor] = useState<Song | null>(null);
  const [editing, setEditing] = useState<Song | null>(null);

  useEffect(() => {
    api.info().then(setInfo).catch(() => {});
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const processing = songs.filter((s) => !["ready", "error"].includes(s.status)).length;
  const recentSingers = Array.from(
    new Set([...playlist.entries.map((e) => e.singer), playlist.now_playing?.singer].filter(Boolean) as string[]),
  ).slice(0, 8);

  const safe = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e: any) {
      setToast(e.message);
    }
  }, []);

  const now = playlist.now_playing;
  const nowSong = now?.song?.status === "ready" ? now : null;
  const nextEntry = playlist.entries[0];

  return (
    <div className="app">
      {/* ------------------------------------------------ sidebar */}
      <nav className="sidebar">
        <div className="brand">
          <img src="/icon.svg" alt="" />
          <span>
            Sing<span className="grad-text">IT</span>now
          </span>
        </div>
        <button className={`nav-item ${tab === "library" ? "active" : ""}`} onClick={() => setTab("library")}>
          <Library size={22} /> Libreria
          {processing > 0 && <span className="nav-count">{processing}</span>}
        </button>
        <button className={`nav-item ${tab === "search" ? "active" : ""}`} onClick={() => setTab("search")}>
          <MonitorPlay size={22} /> Cerca su YouTube
        </button>

        <div className="sidebar-spacer" />

        {info && (
          <div className="join-card">
            <div className="join-title">
              <Smartphone size={18} /> Unisciti dal telefono
            </div>
            <div className="qr" dangerouslySetInnerHTML={{ __html: info.qr_svg }} />
            <div className="join-url">{info.remote_url.replace("http://", "")}</div>
          </div>
        )}
        <div className={`conn ${connected ? "on" : ""}`}>
          {connected ? <Wifi size={14} /> : <WifiOff size={14} />} {connected ? "Connesso" : "Riconnessione…"}
        </div>
      </nav>

      {/* ------------------------------------------------ contenuto */}
      <main className="content">
        {tab === "library" ? (
          <LibraryView
            songs={songs}
            onPlay={(s) => safe(() => api.playSong(s.id))}
            onQueue={setQueueFor}
            onEdit={setEditing}
            onToast={setToast}
            goSearch={() => setTab("search")}
          />
        ) : (
          <SearchView songs={songs} onToast={setToast} />
        )}
      </main>

      {/* ------------------------------------------------ playlist */}
      <aside className="queue">
        <div className="queue-head">
          <h2>
            <ListMusic size={22} /> Playlist
          </h2>
          <span className="muted">{playlist.entries.length} in coda</span>
        </div>

        <button
          className="btn btn-primary btn-block"
          disabled={!nextEntry}
          onClick={() => safe(() => api.playEntry())}
        >
          <Play size={18} fill="currentColor" />
          {nextEntry ? `Avvia: ${nextEntry.singer || nextEntry.song?.title}` : "Coda vuota"}
        </button>

        <ol className="queue-list">
          {playlist.entries.map((e: Entry, i) => (
            <li key={e.id} className="queue-item">
              <div className="queue-pos">{i + 1}</div>
              <div className="cover" style={{ width: 54, height: 54 }}>
                <img src={e.song?.thumbnail_url} alt="" />
              </div>
              <div className="queue-main">
                <div className="queue-singer">
                  <span className="avatar xs">{initials(e.singer || "?")}</span>
                  <span className="ellipsis">{e.singer || "Ospite"}</span>
                </div>
                <div className="queue-song ellipsis">{e.song?.title}</div>
              </div>
              <div className="queue-actions">
                <button className="icon-btn" title="Su" disabled={i === 0} onClick={() => safe(() => api.move(e.id, -1))}>
                  <ChevronUp size={16} />
                </button>
                <button
                  className="icon-btn"
                  title="Giù"
                  disabled={i === playlist.entries.length - 1}
                  onClick={() => safe(() => api.move(e.id, 1))}
                >
                  <ChevronDown size={16} />
                </button>
              </div>
              <div className="queue-actions">
                <button className="icon-btn" title="Avvia ora" onClick={() => safe(() => api.playEntry(e.id))}>
                  <Play size={16} />
                </button>
                <button className="icon-btn danger" title="Rimuovi" onClick={() => safe(() => api.unqueue(e.id))}>
                  <Trash2 size={16} />
                </button>
              </div>
            </li>
          ))}
          {playlist.waiting.map((w, i) => (
            <li key={`w${i}`} className="queue-item waiting">
              <div className="queue-pos">…</div>
              <div className="cover" style={{ width: 54, height: 54 }}>
                <img src={w.song?.thumbnail_url} alt="" />
              </div>
              <div className="queue-main">
                <div className="queue-singer">
                  <span className="avatar xs">{initials(w.singer)}</span>
                  <span className="ellipsis">{w.singer}</span>
                </div>
                <div className="queue-song ellipsis">
                  {w.song?.title} · <span className="muted">in preparazione {Math.round((w.song?.progress ?? 0) * 100)}%</span>
                </div>
              </div>
            </li>
          ))}
        </ol>
        {playlist.entries.length === 0 && playlist.waiting.length === 0 && (
          <div className="queue-empty">
            Nessuno in coda.
            <br />
            Inquadrate il QR code con il telefono per prenotare una canzone!
          </div>
        )}
      </aside>

      {nowSong && (
        <Player
          key={nowSong.id}
          entry={nowSong}
          next={nextEntry}
          onClose={() => safe(() => api.stop())}
          onNext={() => safe(() => (nextEntry ? api.playEntry() : api.stop()))}
        />
      )}

      {queueFor && (
        <SingerDialog
          song={queueFor}
          recent={recentSingers}
          onCancel={() => setQueueFor(null)}
          onConfirm={(singer) => {
            const s = queueFor;
            setQueueFor(null);
            safe(() => api.enqueue(s.id, singer));
          }}
        />
      )}
      {editing && <EditDialog song={editing} onClose={() => setEditing(null)} onToast={setToast} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
