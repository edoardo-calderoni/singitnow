import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Library,
  ListMusic,
  Loader2,
  Plus,
  Search,
  Trash2,
  User,
  ArrowLeft,
  Lock,
  MonitorPlay,
  Mic2,
} from "lucide-react";
import {
  api,
  filterSongs,
  fmtEta,
  fmtTime,
  LANGUAGES,
  languageLabel,
  SearchResult,
  Song,
} from "../shared/api";
import { LivePlayer, useLive } from "../shared/live";
import {
  Avatar,
  avatarKey,
  deleteAvatar,
  uploadAvatar,
  useAvatarUrl,
} from "../shared/Avatar";
import { PhotoPicker } from "./PhotoPicker";
import { adminCheck, adminLogin, adminLogout, getAdminToken } from "./admin";
import {
  ApplauseButton,
  EnableVibration,
  entryStarts,
  vibrate,
  fmtWait,
  GetReadyAlert,
  LyricsTab,
  TurnBanner,
  turnFor,
  useTick,
  AdminControls,
  useVolumeKeys,
} from "./Live";

type Tab = "queue" | "lyrics" | "library" | "search";

export function App() {
  const { songs, playlist, connected, player, synced } = useLive();
  const [name, setName] = useState(
    () => localStorage.getItem("sin.name") ?? "",
  );
  const [tab, setTab] = useState<Tab>("queue");
  const [toast, setToast] = useState("");
  // copia locale della foto profilo (data URL): serve a ricaricarla se il PC non l'ha più
  const [photo, setPhoto] = useState<string | null>(() =>
    localStorage.getItem("sin.photo"),
  );
  const [profileOpen, setProfileOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(() => !!getAdminToken());
  // il gettone da amministratore è ancora valido? (ricontrollato a ogni connessione al PC)
  useEffect(() => {
    if (connected && getAdminToken()) adminCheck().then(setIsAdmin);
  }, [connected]);
  useVolumeKeys(isAdmin, player);
  const serverPhoto = useAvatarUrl(name);

  // la foto c'è sul telefono ma non sul PC (es. cartella dati svuotata): la ricarica da sola
  useEffect(() => {
    if (!synced || !connected || !name || !photo || serverPhoto) return;
    dataUrlToBlob(photo)
      .then((b) => uploadAvatar(name, b))
      .catch(() => {});
  }, [synced, connected, name, photo, serverPhoto]);

  const saveProfile = async (
    newName: string,
    newPhoto: Blob | null | undefined,
  ) => {
    // newPhoto: Blob = nuova foto, null = togli la foto, undefined = invariata
    const oldName = name;
    localStorage.setItem("sin.name", newName);
    setName(newName);
    try {
      if (newPhoto) {
        const url = await blobToDataUrl(newPhoto);
        localStorage.setItem("sin.photo", url);
        setPhoto(url);
        await uploadAvatar(newName, newPhoto);
      } else if (newPhoto === null) {
        localStorage.removeItem("sin.photo");
        setPhoto(null);
        await deleteAvatar(newName);
      } else if (photo && avatarKey(newName) !== avatarKey(oldName)) {
        await uploadAvatar(newName, await dataUrlToBlob(photo)); // nome cambiato: la foto lo segue
      }
      if (
        oldName &&
        avatarKey(oldName) !== avatarKey(newName) &&
        (photo || newPhoto !== undefined)
      )
        await deleteAvatar(oldName);
    } catch (e: any) {
      setToast(e.message);
    }
  };

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

  if (!name)
    return (
      <Welcome
        onDone={(n, ph, admin) => {
          if (admin) setIsAdmin(true);
          saveProfile(n, ph ?? undefined);
        }}
      />
    );

  const mine =
    playlist.entries.filter((e) => e.singer === name).length +
    playlist.waiting.filter((w) => w.singer === name).length;

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
          onClick={() => setProfileOpen(true)}
          title="Il tuo profilo"
        >
          <Avatar name={name} className="xs" /> {name}
          {isAdmin && <span className="m-admin-badge">ADMIN</span>}
        </button>
      </header>
      {!connected && (
        <div className="m-offline">Connessione al PC persa… riprovo</div>
      )}

      <main className="m-main">
        {tab === "queue" && (
          <QueueTab
            name={name}
            isAdmin={isAdmin}
            playlist={playlist}
            player={player}
            safe={safe}
            goLibrary={() => setTab("library")}
          />
        )}
        {tab === "lyrics" && (
          <LyricsTab
            name={name}
            isAdmin={isAdmin}
            playlist={playlist}
            player={player}
          />
        )}
        {tab === "library" && (
          <LibraryTab songs={songs} name={name} safe={safe} goAdd={() => setTab("search")} />
        )}
        {tab === "search" && (
          <SearchTab songs={songs} name={name} safe={safe} onBack={() => setTab("library")} />
        )}
      </main>

      <nav className="m-tabs">
        <button
          className={tab === "queue" ? "on" : ""}
          onClick={() => setTab("queue")}
        >
          <ListMusic size={22} />
          Playlist
          {mine > 0 && <span className="m-dot">{mine}</span>}
        </button>
        <button
          className={tab === "lyrics" ? "on" : ""}
          onClick={() => setTab("lyrics")}
        >
          <Mic2 size={22} />
          Testo
          {playlist.now_playing && <span className="m-live" />}
        </button>
        <button
          className={tab === "library" || tab === "search" ? "on" : ""}
          onClick={() => setTab("library")}
        >
          <Library size={22} />
          Brani
        </button>
      </nav>
      <GetReadyAlert
        name={name}
        playlist={playlist}
        player={player}
        synced={synced}
        onStage={() => setTab("lyrics")}
      />
      {profileOpen && (
        <ProfileSheet
          name={name}
          photo={photo}
          isAdmin={isAdmin}
          onAdminChange={setIsAdmin}
          onClose={() => setProfileOpen(false)}
          onSave={(n, ph) => {
            setProfileOpen(false);
            saveProfile(n, ph).then(() => setToast("Profilo aggiornato"));
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

type Safe = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}
const dataUrlToBlob = (u: string) => fetch(u).then((r) => r.blob());

function Welcome({
  onDone,
}: {
  onDone: (n: string, photo: Blob | null, admin: boolean) => void;
}) {
  const [n, setN] = useState("");
  const [photo, setPhoto] = useState<Blob | null>(null);
  const preview = useMemo(
    () => (photo ? URL.createObjectURL(photo) : null),
    [photo],
  );
  const [admin, setAdmin] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="m-welcome"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!n.trim()) return;
        if (admin) {
          setBusy(true);
          setError("");
          try {
            await adminLogin(password, n.trim());
          } catch (err: any) {
            setError(err.message);
            setBusy(false);
            return;
          }
        }
        onDone(n.trim(), photo, admin);
      }}
    >
      <img src="/icon.svg" alt="" className="m-welcome-logo" />
      <h1>
        Benvenuto su Sing<span className="grad-text">IT</span>now
      </h1>
      <p className="muted">
        Come ti chiami? Il tuo nome e la tua foto appariranno sulla TV quando
        sarà il tuo turno.
      </p>
      <div className="field field-lg">
        <User size={20} />
        <input
          placeholder="Il tuo nome"
          value={n}
          onChange={(e) => setN(e.target.value)}
          maxLength={40}
        />
      </div>
      <PhotoPicker
        preview={preview}
        onPick={setPhoto}
        onRemove={() => setPhoto(null)}
      />
      <AdminFields
        on={admin}
        onToggle={(v) => (setAdmin(v), setError(""))}
        password={password}
        onPassword={setPassword}
        error={error}
      />
      <button
        className="btn btn-primary btn-wide"
        disabled={!n.trim() || busy || (admin && !password)}
      >
        Entra nella festa
      </button>
    </form>
  );
}

function ProfileSheet({
  name,
  photo,
  isAdmin,
  onAdminChange,
  onClose,
  onSave,
}: {
  name: string;
  photo: string | null;
  isAdmin: boolean;
  onAdminChange: (admin: boolean) => void;
  onClose: () => void;
  onSave: (name: string, photo: Blob | null | undefined) => void;
}) {
  const [n, setN] = useState(name);
  const [admin, setAdmin] = useState(isAdmin);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [newPhoto, setNewPhoto] = useState<Blob | null | undefined>(undefined);
  const preview = useMemo(
    () =>
      newPhoto
        ? URL.createObjectURL(newPhoto)
        : newPhoto === null
          ? null
          : photo,
    [newPhoto, photo],
  );
  return (
    <div className="m-sheet" onClick={onClose}>
      <form
        className="m-sheet-card"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!n.trim()) return;
          if (admin && !isAdmin) {
            try {
              await adminLogin(password, n.trim());
              onAdminChange(true);
            } catch (err: any) {
              return setError(err.message);
            }
          } else if (!admin && isAdmin) {
            await adminLogout();
            onAdminChange(false);
          }
          onSave(n.trim(), newPhoto);
        }}
      >
        <div className="m-sheet-title">Il tuo profilo</div>
        <PhotoPicker
          preview={preview}
          onPick={setNewPhoto}
          onRemove={() => setNewPhoto(null)}
        />
        <div className="field field-lg">
          <User size={20} />
          <input
            placeholder="Il tuo nome"
            value={n}
            onChange={(e) => setN(e.target.value)}
            maxLength={40}
          />
        </div>
        {isAdmin && admin ? (
          <div className="m-admin-on">
            <span className="m-admin-badge">ADMIN</span> Sei amministratore
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setAdmin(false)}
            >
              Esci da admin
            </button>
          </div>
        ) : (
          <AdminFields
            on={admin}
            onToggle={(v) => (setAdmin(v), setError(""))}
            password={password}
            onPassword={setPassword}
            error={error}
          />
        )}
        <VibrationTest />
        <div className="m-sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Annulla
          </button>
          <button className="btn btn-primary" disabled={!n.trim()}>
            Salva
          </button>
        </div>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ Playlist
function QueueTab({
  name,
  isAdmin,
  playlist,
  player,
  safe,
  goLibrary,
}: {
  name: string;
  isAdmin: boolean;
  playlist: ReturnType<typeof useLive>["playlist"];
  player: LivePlayer;
  safe: Safe;
  goLibrary: () => void;
}) {
  useTick(1000); // aggiorna i tempi di attesa
  const now = playlist.now_playing;
  const starts = entryStarts(playlist, player);
  return (
    <div className="m-section">
      <TurnBanner turn={turnFor(name, playlist, player)} onAdd={goLibrary} />
      {turnFor(name, playlist, player) && <EnableVibration />}
      {now?.song && (
        <div className={`m-now ${now.song.cover_url ? "has-cover" : ""}`}>
          <img
            className="m-now-bg"
            src={now.song.cover_url || now.song.thumbnail_url}
            alt=""
          />
          <div className="m-now-shade" />
          <div className="m-now-body">
            <div className="eyebrow">
              Sul palco{now.singer ? `: ${now.singer}` : ""}
            </div>
            <div className="m-now-title">{now.song.title}</div>
            <div className="muted">{now.song.artist}</div>
            {/* pausa, stop, avanti, volumi e QR: solo per gli amministratori */}
            {isAdmin && <AdminControls name={name} player={player} />}
            {now.singer !== name && <ApplauseButton name={name} />}
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
            <li
              key={e.id}
              className={`m-item ${e.singer === name ? "mine" : ""}`}
            >
              <div className="m-pos">{i + 1}</div>
              <div className="cover m-cover">
                <img src={e.song?.thumbnail_url} alt="" />
              </div>
              <div className="m-item-main">
                <div className="m-item-title ellipsis">{e.song?.title}</div>
                <div className="m-item-sub ellipsis">
                  <b>{e.singer || "Ospite"}</b> ·{" "}
                  {fmtTime(e.song?.duration ?? 0)}
                  {e.singer === name && (i > 0 || now) && (
                    <span className="m-when"> · fra {fmtWait(starts[i]!)}</span>
                  )}
                </div>
              </div>
              {isAdmin && (
                <div className="m-item-act">
                  <button
                    className="icon-btn"
                    disabled={i === 0}
                    onClick={() => safe(() => api.move(e.id, -1))}
                  >
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
              )}
              {(e.singer === name || isAdmin) && (
                <button
                  className="icon-btn danger"
                  title="Togli dalla playlist"
                  onClick={() =>
                    safe(
                      () => api.unqueue(e.id, name),
                      "Brano tolto dalla playlist",
                    )
                  }
                >
                  <Trash2 size={18} />
                </button>
              )}
            </li>
          ))}
          {playlist.waiting.map((w, i) => (
            <li
              key={`w${i}`}
              className={`m-item waiting ${w.singer === name ? "mine" : ""}`}
            >
              <div className="m-pos">
                <Loader2 size={14} className="spin" />
              </div>
              <div className="cover m-cover">
                <img src={w.song?.thumbnail_url} alt="" />
              </div>
              <div className="m-item-main">
                <div className="m-item-title ellipsis">{w.song?.title}</div>
                <div className="m-item-sub ellipsis">
                  <b>{w.singer}</b> · in preparazione{" "}
                  {Math.round((w.song?.progress ?? 0) * 100)}%
                  {fmtEta(w.song) && ` · ${fmtEta(w.song)}`}
                </div>
              </div>
              {(w.singer === name || isAdmin) && (
                <button
                  className="icon-btn danger"
                  title="Annulla la prenotazione"
                  onClick={() =>
                    safe(
                      () => api.unqueueWaiting(w.song_id, w.singer),
                      "Prenotazione annullata",
                    )
                  }
                >
                  <Trash2 size={18} />
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Libreria
function LibraryTab({
  songs,
  name,
  safe,
  goAdd,
}: {
  songs: Song[];
  name: string;
  safe: Safe;
  goAdd: () => void;
}) {
  const [text, setText] = useState("");
  const [lang, setLang] = useState("");
  const ready = useMemo(
    () =>
      filterSongs(
        songs.filter((s) => s.status === "ready"),
        text,
        lang,
      ),
    [songs, text, lang],
  );
  return (
    <div className="m-section">
      <button className="btn btn-primary btn-wide m-add-song" onClick={goAdd}>
        <Plus size={18} /> Aggiungi brano
      </button>
      <div className="m-filters">
        <div className="field">
          <Search size={18} />
          <input
            placeholder="Titolo o artista"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="field m-lang">
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            aria-label="Lingua"
          >
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
          <p>Tocca «Aggiungi brano» per cercarne uno nuovo su YouTube.</p>
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
                  {s.language && (
                    <span className="badge lang">
                      {languageLabel(s.language)}
                    </span>
                  )}
                </div>
              </div>
              <button
                className="btn btn-primary btn-sm"
                onClick={() =>
                  safe(() => api.enqueue(s.id, name), "Prenotato! 🎤")
                }
              >
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
function SearchTab({
  songs,
  name,
  safe,
  onBack,
}: {
  songs: Song[];
  name: string;
  safe: Safe;
  onBack: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map(songs.map((s) => [s.id, s])), [songs]);

  return (
    <div className="m-section">
      <div className="m-subhead">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Torna ai brani">
          <ArrowLeft size={20} />
        </button>
        <h2 className="m-h2">Aggiungi brano</h2>
      </div>
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
          <input
            type="search"
            placeholder="Artista e titolo"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <button className="btn btn-primary" disabled={busy || !q.trim()}>
          {busy ? <Loader2 size={16} className="spin" /> : <Search size={16} />}
        </button>
      </form>
      {results === null && (
        <div className="empty">
          <h3>Non trovi la tua canzone?</h3>
          <p>
            Cercala su YouTube: verrà preparata per il karaoke e messa in coda
            con il tuo nome.
          </p>
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
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    safe(() => api.enqueue(s.id, name), "Prenotato! 🎤")
                  }
                >
                  <Check size={16} /> Canto
                </button>
              ) : (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() =>
                    safe(
                      () => api.download(r, name),
                      "Lo preparo e ti metto in coda!",
                    )
                  }
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

/** Verifica subito se questo telefono può vibrare (serve per l'avviso "tocca a te"). */
function VibrationTest() {
  const [result, setResult] = useState("");
  return (
    <div className="m-vibtest">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() =>
          setResult(
            typeof navigator.vibrate !== "function"
              ? "Questo browser non può far vibrare il telefono (succede su iPhone)."
              : vibrate([300, 120, 300])
                ? "Hai sentito la vibrazione? Se no, controlla che il telefono non sia in modalità silenziosa o Non disturbare."
                : "Il browser ha bloccato la vibrazione: riprova toccando di nuovo il pulsante.",
          )
        }
      >
        📳 Prova la vibrazione
      </button>
      {result && <p className="muted">{result}</p>}
      <p className="muted small">
        Per ricevere l'avviso tieni lo schermo acceso con questa pagina aperta:
        a schermo spento il telefono sospende il browser.
      </p>
    </div>
  );
}

/** Interruttore "ADMIN" (spento di default): acceso, chiede la password da amministratore. */
function AdminFields({
  on,
  onToggle,
  password,
  onPassword,
  error,
}: {
  on: boolean;
  onToggle: (on: boolean) => void;
  password: string;
  onPassword: (p: string) => void;
  error: string;
}) {
  return (
    <div className="m-admin">
      <label className="m-switch">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span className="m-switch-track" aria-hidden>
          <span className="m-switch-thumb" />
        </span>
        <span className="m-switch-label">ADMIN</span>
      </label>
      {on && (
        <div className="field">
          <Lock size={18} />
          <input
            type="password"
            placeholder="Password amministratore"
            autoComplete="current-password"
            value={password}
            onChange={(e) => onPassword(e.target.value)}
            autoFocus
          />
        </div>
      )}
      {on && error && <div className="m-admin-err">{error}</div>}
    </div>
  );
}
