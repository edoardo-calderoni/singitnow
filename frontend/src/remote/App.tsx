import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Clock,
  Library,
  ListMusic,
  Loader2,
  Plus,
  Search,
  Trash2,
  User,
  LogOut,
  ArrowLeft,
  MonitorPlay,
  Mic2,
  Play,
  ChevronDown,
  Settings,
  Inbox,
  Headphones,
  X,
} from "lucide-react";
import {
  api,
  filterSongs,
  fmtTime,
  LANGUAGES,
  languageLabel,
  Entry,
  Person,
  ScoreEntry,
  SearchResult,
  Song,
  youtubeId,
  PC_UNREACHABLE,
} from "../shared/api";
import { LivePlayer, setPresence, useLive } from "../shared/live";
import { useDj, useDjAt, useJukebox, useMode } from "../shared/mode";
import { useSettings } from "../shared/settings";
import { useYoutubeSearch } from "../shared/search";
import { openExternal } from "../shared/external";
import {
  Avatar,
  avatarKey,
  deleteAvatar,
  uploadAvatar,
  useAvatarUrl,
} from "../shared/Avatar";
import { PhotoPicker } from "./PhotoPicker";
import { ImportSheet } from "./ImportSheet";
import { Ranking } from "./Ranking";
import { InstallBanner } from "./InstallBanner";
import { AddedNotice, useAddedNotice } from "./AddedNotice";
import { ConnectionLost } from "./ConnectionLost";
import { DjRequests } from "./DjRequests";
import { Preparing } from "./Preparing";
import { AdminPasswordCard, PlaylistSettingsCard, ScreenCard } from "./SettingsCards";
import { DjElected, Turntable } from "./DjElected";
import { PasswordInput } from "../shared/PasswordInput";
import { useReorder } from "./useReorder";
import { DuetControls, DuetInvite, DuetNotice, useDuetNotice } from "./Duet";
import { singersOf, singsIn } from "../shared/queue";
import { AppQrCard, WifiCard } from "./Wifi";
import { adminCheck, adminLogin, adminLogout, getAdminToken } from "./admin";
import {
  ApplauseButton,
  EnableVibration,
  entryStarts,
  fmtWait,
  GetReadyAlert,
  LyricsTab,
  TurnBanner,
  turnFor,
  useTick,
  AdminControls,
  useVolumeKeys,
  ModeSwitch,
  MicCard,
} from "./Live";

type Tab = "queue" | "lyrics" | "library" | "search" | "requests" | "settings";

export function App() {
  // nome e cognome di chi usa il telefono; nella festa è chiamato col solo nome, oppure con
  // l'iniziale del cognome se c'è un omonimo (lo decide il PC: evento "people")
  const [first, setFirst] = useState(() => localStorage.getItem("sin.first") ?? "");
  const [last, setLast] = useState(() => localStorage.getItem("sin.last") ?? "");
  const [people, setPeople] = useState<Person[]>([]);
  const me = people.find(
    (p) => p.first.toLocaleLowerCase() === first.trim().toLocaleLowerCase() && p.last.toLocaleLowerCase() === last.trim().toLocaleLowerCase(),
  );
  const name = first && last ? (me?.name ?? first.trim()) : "";
  useEffect(() => {
    if (name) localStorage.setItem("sin.name", name); // usato anche fuori da qui (es. competizione)
  }, [name]);
  const nameRef = useRef(name);
  nameRef.current = name;
  const [ranking, setRanking] = useState<ScoreEntry[]>([]);
  const added = useAddedNotice(name); // «X ha aggiunto …» quando qualcun altro aggiunge un brano
  const duet = useDuetNotice(name); // risposte alle proposte di duetto
  const { songs, playlist, connected, player, synced } = useLive((event, data) => {
    if (event === "scores") setRanking(data.ranking ?? []);
    if (event === "admin_logout") adminCheck().then(setIsAdmin); // password cambiata dal PC
    if (event === "added") added.push(data); // brano entrato in coda (pronto, non più in preparazione)
    if (event === "duet") duet.push(data); // proposta di duetto accettata, rifiutata o annullata
    if (event === "users") setUsers(Array.isArray(data) ? data : []); // chi è collegato dal telefono
    if (event === "people") setPeople(Array.isArray(data) ? data : []); // nomi nella festa (omonimi)
    if (event === "score" && data.singer && data.singer === nameRef.current)
      setToast(`🎤 Intonazione: ${data.score}/100${data.position ? ` · ${data.position}° posto` : ""}`);
  });
  useEffect(() => {
    if (connected) api.scores().then((r) => setRanking(r.ranking)).catch(() => {});
  }, [connected]);
  // utenti collegati: all'avvio e a ogni riconnessione, poi li aggiorna l'evento "users"
  const [users, setUsers] = useState<string[]>([]);
  useEffect(() => {
    if (connected) api.users().then((r) => setUsers(r.users)).catch(() => {});
    if (connected) api.people().then((r) => setPeople(r.people)).catch(() => {});
  }, [connected]);
  // «Proponi duetto» solo se c'è almeno un altro utente collegato
  const othersOnline = users.some((u) => u.trim().toLocaleLowerCase() !== name.trim().toLocaleLowerCase());
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
  // chi smette di essere amministratore mentre è nei Settaggi torna al Live
  useEffect(() => {
    if (!isAdmin && tab === "settings") setTab("queue");
  }, [isAdmin, tab]);
  // il PC sa chi è collegato (per scegliere chi canta quando si aggiunge un brano dalla TV)
  useEffect(() => setPresence(first.trim(), last.trim()), [first, last]);
  // app Android: avvisa quando tocca a te anche a schermo spento (servizio dell'app)
  useEffect(() => {
    if (first.trim() && last.trim()) window.SingITnowApp?.setIdentity?.(first.trim(), last.trim());
  }, [first, last]);
  // altezza reale dell'intestazione (cambia da telefono a telefono): serve a ciò che le sta sotto
  useEffect(() => {
    const head = document.querySelector<HTMLElement>(".m-head");
    if (!head) return;
    const set = () => document.documentElement.style.setProperty("--m-head-h", `${head.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(head);
    return () => ro.disconnect();
  }, [name]);
  const jukebox = useJukebox();
  const locked = useSettings()?.locked ?? false;
  const mode = useMode();
  const dj = useDj(); // modalità DJ: solo lui (e gli amministratori) aggiunge brani
  const djAt = useDjAt();
  const iAmDj = !!dj && dj.toLocaleLowerCase() === name.trim().toLocaleLowerCase();
  // modalità DJ con «Solo gli Admin» (nessun DJ eletto): gli amministratori fanno da DJ
  // «Blocca inserimenti e richieste»: la playlist la gestiscono solo gli amministratori (e il PC);
  // gli altri, DJ compreso, non aggiungono né chiedono brani e non vedono la Libreria
  const blocked = locked && !isAdmin;
  const actsAsDj = !blocked && (iAmDj || (mode === "dj" && !dj && isAdmin));
  useEffect(() => {
    if (blocked && (tab === "library" || tab === "search")) setTab("queue");
  }, [blocked, tab]);
  const requests = playlist.requests ?? [];
  // chi smette di fare il DJ mentre è nelle Richieste torna al Live
  useEffect(() => {
    if (!actsAsDj && tab === "requests") setTab("queue");
  }, [actsAsDj, tab]);
  const serverPhoto = useAvatarUrl(name);

  // la foto c'è sul telefono ma non sul PC (es. cartella dati svuotata): la ricarica da sola
  useEffect(() => {
    if (!synced || !connected || !name || !photo || serverPhoto) return;
    dataUrlToBlob(photo)
      .then((b) => uploadAvatar(name, b))
      .catch(() => {});
  }, [synced, connected, name, photo, serverPhoto]);

  const saveProfile = async (
    newFirst: string,
    newLast: string,
    newPhoto: Blob | null | undefined,
  ) => {
    // newPhoto: Blob = nuova foto, null = togli la foto, undefined = invariata
    const oldName = name;
    localStorage.setItem("sin.first", newFirst);
    localStorage.setItem("sin.last", newLast);
    setFirst(newFirst);
    setLast(newLast);
    // nome nella festa: lo conferma il PC (con l'iniziale del cognome se c'è un omonimo)
    const newName =
      people.find(
        (p) => p.first.toLocaleLowerCase() === newFirst.toLocaleLowerCase() && p.last.toLocaleLowerCase() === newLast.toLocaleLowerCase(),
      )?.name ?? (oldName && avatarKey(oldName).startsWith(avatarKey(newFirst)) ? oldName : newFirst);
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
      <>
        <Welcome
          connected={connected}
          initialFirst={first || localStorage.getItem("sin.name") || ""}
          initialLast={last}
          onDone={(f, l, ph, admin) => {
            if (admin) setIsAdmin(true);
            saveProfile(f, l, ph ?? undefined);
          }}
        />
        <ConnectionLost connected={connected} />
      </>
    );

  return (
    <div className="m-app">
      <header className="m-head">
        <div className="m-brand">
          <img src="/icon.svg" alt="" />
          <span>
            Sing<span className="grad-text">IT</span>now
          </span>
          {jukebox && <span className="m-mode-pill">{mode === "dj" ? "DJ" : "JUKEBOX"}</span>}
        </div>
        <button
          className="m-user"
          onClick={() => setProfileOpen(true)}
          title="Il tuo profilo"
        >
          <Avatar name={name} className="xs" /> {name}
        </button>
      </header>
      {/* connessione persa: niente striscia in alto, dopo 5 secondi la schermata ConnectionLost */}

      <main className="m-main">
        <InstallBanner />
        {tab === "queue" && (
          <QueueTab
            name={name}
            isAdmin={isAdmin}
            playlist={playlist}
            player={player}
            safe={safe}
            goLibrary={() => setTab("library")}
            goLyrics={() => setTab("lyrics")}
            ranking={ranking}
            iAmDj={actsAsDj}
            blocked={blocked}
            othersOnline={othersOnline}
          />
        )}
        {tab === "lyrics" && (
          <LyricsTab
            name={name}
            playlist={playlist}
            player={player}
          />
        )}
        {mode === "dj" && !locked && !iAmDj && !isAdmin && (tab === "library" || tab === "search") && (
          <div className="m-locked">
            <Headphones size={18} />
            {dj
              ? `Modalità DJ: i brani che aggiungi vengono inviati a ${dj}, che deciderà se metterli in playlist`
              : "Modalità DJ: i brani che aggiungi vengono inviati agli Admin, che decideranno se metterli in playlist"}
          </div>
        )}
        {tab === "library" && (
          <LibraryTab songs={songs} name={name} safe={safe} goAdd={() => setTab("search")} />
        )}
        {tab === "search" && (
          <SearchTab songs={songs} name={name} safe={safe} onBack={() => setTab("library")} />
        )}
        {/* modalità DJ: tutte le richieste ricevute, da accettare o rifiutare */}
        {tab === "requests" && actsAsDj && (
          <div className="m-section">
            {requests.length ? (
              <DjRequests
                requests={requests}
                name={name}
                canManage
                safe={safe}
                approve={(id) => api.approveRequest(id, name)}
                reject={(id) => api.rejectRequest(id, name)}
              />
            ) : (
              <div className="empty">
                <h3>Nessuna richiesta</h3>
                <p>Qui arrivano i brani che gli altri vorrebbero ascoltare: decidi tu se metterli in playlist.</p>
              </div>
            )}
          </div>
        )}
        {/* impostazioni della serata: solo per gli amministratori */}
        {tab === "settings" && isAdmin && (
          <div className="m-section">
            <ModeSwitch />
            <PlaylistSettingsCard />
            <ScreenCard />
            <MicCard />
            <WifiCard />
            <AppQrCard />
            <AdminPasswordCard />
          </div>
        )}
      </main>

      <nav className="m-tabs">
        <button
          className={tab === "queue" ? "on" : ""}
          onClick={() => setTab("queue")}
        >
          <Mic2 size={22} />
          Live
        </button>
        <button
          className={tab === "lyrics" ? "on" : ""}
          onClick={() => setTab("lyrics")}
        >
          <ListMusic size={22} />
          Testo
          {playlist.now_playing && <span className="m-live" />}
        </button>
        {!blocked && (
          <button
            className={tab === "library" || tab === "search" ? "on" : ""}
            onClick={() => setTab("library")}
          >
            <Library size={22} />
            Libreria
          </button>
        )}
        {actsAsDj && (
          <button className={tab === "requests" ? "on" : ""} onClick={() => setTab("requests")}>
            <Inbox size={22} />
            Richieste
            {requests.length > 0 && <span className="m-badge">{requests.length}</span>}
          </button>
        )}
        {isAdmin && (
          <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>
            <Settings size={22} />
            Settaggi
          </button>
        )}
      </nav>
      {!jukebox && <GetReadyAlert
        name={name}
        playlist={playlist}
        player={player}
        synced={synced}
        onStage={() => setTab("lyrics")}
      />}
      {profileOpen && (
        <ProfileSheet
          first={first}
          last={last}
          photo={photo}
          isAdmin={isAdmin}
          onAdminChange={setIsAdmin}
          onClose={() => setProfileOpen(false)}
          onSave={(f, l, ph) => {
            setProfileOpen(false);
            saveProfile(f, l, ph).then(() => setToast("Profilo aggiornato"));
          }}
          onLogout={async () => {
            // esce dalla festa: il telefono dimentica chi lo usava e torna alla schermata per entrare
            setProfileOpen(false);
            if (isAdmin) await adminLogout().catch(() => {});
            setIsAdmin(false);
            for (const k of ["sin.first", "sin.last", "sin.name", "sin.photo"]) localStorage.removeItem(k);
            window.SingITnowApp?.clearIdentity?.(); // niente più avvisi «Tocca a te» su questo telefono
            setFirst("");
            setLast("");
            setPhoto(null);
            setTab("queue");
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
      <AddedNotice notice={added.notice} />
      <DuetNotice notice={duet.notice} />
      {/* proposta di duetto ricevuta: si accetta o si rifiuta (solo in Karaoke) */}
      {!jukebox && <DuetInvite name={name} playlist={playlist} player={player} safe={safe} />}
      <DjElected iAmDj={iAmDj} electedAt={djAt} />
      <ConnectionLost connected={connected} />
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
  connected,
  initialFirst,
  initialLast,
}: {
  onDone: (first: string, last: string, photo: Blob | null, admin: boolean) => void;
  connected: boolean;
  initialFirst: string;
  initialLast: string;
}) {
  // nome e cognome: il cognome serve a distinguere gli omonimi (alla festa e nella Hall of Fame)
  const [n, setN] = useState(initialFirst);
  const [l, setL] = useState(initialLast);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const preview = useMemo(
    () => (photo ? URL.createObjectURL(photo) : null),
    [photo],
  );
  const [admin, setAdmin] = useState(false); // acceso solo dopo la password giusta nel popup
  const [password, setPassword] = useState("");
  const [loginName, setLoginName] = useState(""); // nome con cui si è fatto l'accesso nel popup
  const [busy, setBusy] = useState(false);
  // PC non raggiungibile da qualche secondo (all'apertura la connessione impiega un attimo)
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (connected) return setOffline(false);
    const id = window.setTimeout(() => setOffline(true), 2500);
    return () => window.clearTimeout(id);
  }, [connected]);
  return (
    <form
      className="m-welcome"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!n.trim() || !l.trim()) return;
        if (admin && loginName !== n.trim()) {
          // nel popup si è entrati con un altro nome (o senza): l'accesso si rifà col nome giusto
          setBusy(true);
          await adminLogin(password, n.trim()).catch(() => {});
          setBusy(false);
        }
        onDone(n.trim(), l.trim(), photo, admin);
      }}
    >
      <InstallBanner />
      {offline && <div className="m-offline m-welcome-offline">Connessione persa: apri SingITnow sul PC… riprovo</div>}
      <div className="m-welcome-head">
        <img src="/icon.svg" alt="" className="m-welcome-logo" />
        <h1>
          Benvenuto su Sing<span className="grad-text">IT</span>now
        </h1>
      </div>
      <p className="muted">
        Inserisci nome e cognome, carica una foto e unisciti alla festa!
      </p>
      <div className="field field-lg">
        <User size={20} />
        <input
          placeholder="Nome"
          value={n}
          onChange={(e) => setN(e.target.value)}
          maxLength={30}
          autoComplete="given-name"
        />
      </div>
      <div className="field field-lg">
        <User size={20} />
        <input
          placeholder="Cognome"
          value={l}
          onChange={(e) => setL(e.target.value)}
          maxLength={30}
          autoComplete="family-name"
        />
      </div>
      <p className="muted m-welcome-note">Alla festa sarai chiamato solo per nome: il cognome serve a distinguere gli omonimi.</p>
      <PhotoPicker
        preview={preview}
        onPick={setPhoto}
        onRemove={() => setPhoto(null)}
      />
      <AdminSwitch
        on={admin}
        name={n.trim()}
        unreachable={offline}
        onLogin={(pw, who) => (setAdmin(true), setPassword(pw), setLoginName(who))}
        onOff={() => {
          setAdmin(false);
          adminLogout(); // l'accesso fatto nel popup non resta attivo
        }}
      />
      <button className="btn btn-primary btn-wide" disabled={!n.trim() || !l.trim() || busy}>
        Entra!
      </button>
    </form>
  );
}

function ProfileSheet({
  first,
  last,
  photo,
  isAdmin,
  onAdminChange,
  onClose,
  onSave,
  onLogout,
}: {
  first: string;
  last: string;
  photo: string | null;
  isAdmin: boolean;
  onAdminChange: (admin: boolean) => void;
  onClose: () => void;
  onSave: (first: string, last: string, photo: Blob | null | undefined) => void;
  onLogout: () => void;
}) {
  const [n, setN] = useState(first);
  const [l, setL] = useState(last);
  // acceso se già amministratore; spento e riacceso richiede di nuovo la password (popup)
  const [admin, setAdmin] = useState(isAdmin);
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
          if (!n.trim() || !l.trim()) return;
          if (!admin && isAdmin) {
            await adminLogout();
            onAdminChange(false);
          }
          onSave(n.trim(), l.trim(), newPhoto);
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
          <input placeholder="Nome" value={n} onChange={(e) => setN(e.target.value)} maxLength={30} />
        </div>
        <div className="field field-lg">
          <User size={20} />
          <input placeholder="Cognome" value={l} onChange={(e) => setL(e.target.value)} maxLength={30} />
        </div>
        <AdminSwitch
          on={admin}
          name={n.trim()}
          onLogin={() => {
            setAdmin(true);
            onAdminChange(true); // password giusta: si è subito amministratori
          }}
          onOff={() => setAdmin(false)} // si esce salvando il profilo
        />
        <div className="m-sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Annulla
          </button>
          <button className="btn btn-primary" disabled={!n.trim() || !l.trim()}>
            Salva
          </button>
        </div>
        <button
          type="button"
          className="btn btn-ghost m-logout"
          onClick={() => {
            if (confirm("Vuoi uscire dalla festa? Dovrai inserire di nuovo nome e cognome per rientrare.")) onLogout();
          }}
        >
          <LogOut size={18} /> Esci
        </button>
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
  goLyrics,
  ranking,
  iAmDj,
  blocked,
  othersOnline,
}: {
  name: string;
  isAdmin: boolean;
  playlist: ReturnType<typeof useLive>["playlist"];
  player: LivePlayer;
  safe: Safe;
  goLibrary: () => void;
  goLyrics: () => void;
  ranking: ScoreEntry[];
  iAmDj: boolean;
  blocked: boolean; // «Blocca inserimenti e richieste»: niente modifiche alla playlist
  othersOnline: boolean; // c'è qualcun altro collegato con cui fare un duetto
}) {
  useTick(1000); // aggiorna i tempi di attesa
  const dj = useDj();
  const mode = useMode();
  // togliere e spostare qualsiasi brano della playlist: amministratori e DJ della serata
  const canManage = isAdmin || iAmDj;
  // il DJ è l'unico ad aggiungere brani: sulla sua app non serve il nome di chi li ha aggiunti
  const showWho = !iAmDj;
  const now = playlist.now_playing;
  const jukebox = useJukebox();
  // amministratori: tenendo premuto un brano lo si trascina in un'altra posizione
  const [listEl, setListEl] = useState<HTMLOListElement | null>(null);
  const [order, setOrder] = useState<string[] | null>(null); // nuovo ordine in attesa della conferma del PC
  useEffect(() => setOrder(null), [playlist.entries]);
  const { drag, styleFor } = useReorder(listEl, canManage, (id, delta) => {
    const ids = playlist.entries.map((e) => e.id);
    const from = ids.indexOf(id);
    ids.splice(from + delta, 0, ...ids.splice(from, 1));
    setOrder(ids); // la riga resta subito dove la si è lasciata
    safe(() => api.move(id, delta, name));
  });
  const entries = order
    ? order.map((id) => playlist.entries.find((e) => e.id === id)).filter((e): e is Entry => !!e)
    : playlist.entries;
  const starts = entryStarts({ ...playlist, entries }, player);
  return (
    <div className="m-section">
      {/* il DJ aggiunge tutti i brani: niente «Il tuo brano è il prossimo» */}
      {!iAmDj && <TurnBanner turn={turnFor(name, playlist, player)} onAdd={goLibrary} onLyrics={goLyrics} />}
      {!jukebox && turnFor(name, playlist, player) && <EnableVibration />}
      {now?.song && (
        <div className={`m-now ${now.song.cover_url ? "has-cover" : ""}`}>
          <img
            className="m-now-bg"
            src={now.song.cover_url || now.song.thumbnail_url}
            alt=""
          />
          <div className="m-now-shade" />
          {/* chi l'ha richiesto (o un amministratore) può toglierlo: si interrompe e parte il prossimo */}
          {((now.singer && now.singer === name && !blocked) || canManage) && (
            <button
              className="icon-btn danger m-now-remove"
              title="Togli dalla playlist"
              onClick={() => {
                if (!confirm(`Togliere «${now.song!.title}» dalla playlist? Il brano si interrompe.`)) return;
                safe(() => api.unqueue(now.id, name), "Brano eliminato");
              }}
            >
              <Trash2 size={18} />
            </button>
          )}
          <div className="m-now-body">
            <div className="eyebrow">
              {jukebox
                ? now.singer && showWho
                  ? `Brano aggiunto da ${now.singer}`
                  : "In riproduzione"
                : `${now.partner ? "Duetto sul palco" : "Sul palco"}${now.singer ? `: ${singersOf(now)}` : ""}`}
            </div>
            <div className="m-now-title">{now.song.title}</div>
            <div className="muted">{now.song.artist}</div>
            {/* pausa, stop, avanti e volumi: solo per gli amministratori */}
            {isAdmin && <AdminControls name={name} player={player} />}
            {!singsIn(now, name) && !jukebox && <ApplauseButton name={name} />}
          </div>
        </div>
      )}

      {/* amministratore: i brani che aggiunge non partono da soli, la playlist si avvia da qui */}
      {isAdmin && !now && playlist.entries.length > 0 && (
        <button
          className="btn btn-primary btn-block m-start-playlist"
          onClick={() => api.playEntry().catch((e) => alert(e.message))}
        >
          <Play size={18} fill="currentColor" /> Avvia playlist
        </button>
      )}

      {/* modalità DJ: richieste degli utenti (il DJ le accetta, chi le ha fatte le vede in attesa) */}
      <DjRequests
        requests={playlist.requests ?? []}
        name={name}
        canManage={canManage}
        canWithdraw={!blocked}
        safe={safe}
        approve={(id) => api.approveRequest(id, name)}
        reject={(id) => api.rejectRequest(id, name)}
      />
      {/* brani prenotati ancora in preparazione: fuori dalla playlist, si possono annullare */}
      <Preparing waiting={playlist.waiting} name={name} canManage={canManage} canWithdraw={!blocked} safe={safe} />
      {/* modalità DJ: etichetta sopra il titolo della playlist */}
      {/* con «Solo gli Admin» gli amministratori fanno da DJ, ma la card non serve */}
      {/* «Blocca inserimenti e richieste»: nessuna card del DJ (neanche per il DJ) */}
      {blocked ? null : iAmDj ? (
        dj && (
          <div className="m-locked m-dj-me m-dj-live">
            <Turntable size={30} /> Sei il DJ della serata!
          </div>
        )
      ) : dj ? (
        <div className="m-locked m-dj-me m-dj-live">
          <Turntable size={30} /> {dj} è il DJ della serata!
        </div>
      ) : (
        mode === "dj" && (
          <div className="m-locked m-dj-me m-dj-live">
            <Turntable size={30} /> Gli Admin sono i DJ della serata!
          </div>
        )
      )}
      <h2 className="m-h2">{jukebox ? "Playlist" : "Prossimi a cantare"}</h2>
      {playlist.entries.length === 0 ? (
        <div className="empty">
          <h3>La coda è vuota</h3>
          <p>Prenota la tua canzone!</p>
          <button className="btn btn-primary" onClick={goLibrary}>
            <Plus size={18} /> Scegli un brano
          </button>
        </div>
      ) : (
        <ol className={`m-list ${drag ? "reordering" : ""}`} ref={setListEl}>
          {canManage && entries.length > 1 && !drag && (
            <li className="m-reorder-hint">Tieni premuto un brano e trascinalo per cambiarne la posizione</li>
          )}
          {entries.map((e, i) => (
            <li
              key={e.id}
              data-entry-id={canManage ? e.id : undefined}
              className={`m-item m-qitem ${singsIn(e, name) && showWho ? "mine" : ""} ${e.partner && !jukebox ? "duet" : ""} ${canManage ? "draggable" : ""} ${drag?.id === e.id ? "dragging" : ""}`}
              style={styleFor(e.id, i)}
            >
              <div className="m-pos">{i + 1}</div>
              {/* copertina del disco come sfondo della card, scurita per leggere bene il testo */}
              {e.song?.thumbnail_url && <img className="m-qbg" src={e.song.thumbnail_url} alt="" />}
              <div className="m-item-main">
                {/* tutto per intero (titolo e artista vanno a capo); chi l'ha richiesto per ultimo */}
                <div className="m-item-title wrap">{e.song?.title}</div>
                {e.song?.artist && <div className="m-item-artist">{e.song.artist}</div>}
                <div className="m-item-meta">
                  <span>
                    <Clock size={13} /> {fmtTime(e.song?.duration ?? 0)}
                  </span>
                  <span className={singsIn(e, name) ? "m-when" : "m-wait"}>
                    {i === 0 && !now ? "è il prossimo" : `fra ${fmtWait(starts[i]!)}`}
                  </span>
                </div>
                {e.singer && showWho && (
                  <div className="m-qsinger">
                    <Avatar name={e.singer} className="xs" /> <b>{e.singer}</b>
                    {/* duetto accettato: i due cantanti, con l'etichetta «Duetto» */}
                    {e.partner && !jukebox && (
                      <>
                        <span className="m-duet-amp">&</span>
                        <Avatar name={e.partner} className="xs" /> <b>{e.partner}</b>
                        <span className="m-duet-chip">Duetto</span>
                      </>
                    )}
                  </div>
                )}
                {/* Karaoke: chi ha prenotato propone un duetto a un altro utente collegato */}
                {!jukebox && !blocked && (
                  <DuetControls
                    entry={e}
                    name={name}
                    proposal={playlist.duets?.find((d) => d.entry_id === e.id)}
                    canPropose={othersOnline}
                    safe={safe}
                  />
                )}
              </div>
              {((e.singer === name && !blocked) || canManage) && (
                <button
                  className="icon-btn danger"
                  title="Togli dalla playlist"
                  onClick={() =>
                    safe(
                      () => api.unqueue(e.id, name),
                      "Brano eliminato",
                    )
                  }
                >
                  <Trash2 size={18} />
                </button>
              )}
            </li>
          ))}
          {/* i brani ancora in preparazione non si vedono: entrano in playlist quando sono pronti */}
        </ol>
      )}
      {!jukebox && <Ranking ranking={ranking} name={name} />}
    </div>
  );
}

// ------------------------------------------------------------------ Libreria
/** Messaggi dopo l'aggiunta di un brano: in modalità DJ, per chi non è DJ né amministratore,
 * il brano diventa una richiesta al DJ. */
function useAddMessages(name: string) {
  const mode = useMode();
  const dj = useDj();
  const jukebox = useJukebox();
  const iAmDj = !!dj && dj.toLocaleLowerCase() === name.trim().toLocaleLowerCase();
  const toDj = mode === "dj" && !iAmDj && !getAdminToken();
  return {
    addedMsg: toDj ? "🎧 Richiesta inviata al DJ!" : jukebox ? "🎵 Aggiunto alla coda!" : "🎤 Prenotato!",
    preparingMsg: toDj ? "Lo preparo e lo invio al DJ!" : "Lo preparo e ti metto in coda!",
  };
}

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
  const { addedMsg } = useAddMessages(name);
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
        <Plus size={18} /> Nuovo brano
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
          <p>Tocca «Nuovo brano» per cercarne uno nuovo su YouTube.</p>
        </div>
      ) : (
        <ul className="m-list">
          {ready.map((s) => (
            <li key={s.id} className="m-item">
              <div className="cover m-cover">
                <img src={s.thumbnail_url} alt="" loading="lazy" />
              </div>
              <div className="m-item-main">
                {/* tutto per intero: titolo e artista vanno a capo invece di essere troncati */}
                <div className="m-item-title wrap">{s.title}</div>
                {s.artist && <div className="m-item-artist">{s.artist}</div>}
                <div className="m-item-meta">
                  <span>
                    <Clock size={13} /> {fmtTime(s.duration)}
                  </span>
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
                  safe(() => api.enqueue(s.id, name), addedMsg)
                }
              >
                Aggiungi
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
  const { addedMsg, preparingMsg } = useAddMessages(name);
  const [q, setQ] = useState("");
  // gli errori passano da safe(), che li mostra come avviso
  const search = useYoutubeSearch((msg) => safe(() => Promise.reject(new Error(msg))));
  const { results, busy } = search;
  const byId = useMemo(() => new Map(songs.map((s) => [s.id, s])), [songs]);
  const run = (text: string) => search.run(text);
  // prima di importare si confermano artista e titolo (servono a trovare il testo giusto)
  const [importing, setImporting] = useState<SearchResult | null>(null);

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
        onSubmit={(e) => {
          e.preventDefault();
          run(q);
        }}
      >
        <div className="field">
          <MonitorPlay size={18} />
          <input
            type="search"
            placeholder="Artista e titolo o link YouTube"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              // link incollato: si cerca subito quel video
              const id = youtubeId(e.target.value);
              if (id && id !== youtubeId(q)) run(e.target.value);
            }}
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
            con il tuo nome. Puoi anche incollare il link di un video di YouTube.
          </p>
        </div>
      )}
      <ul className="m-list">
        {results?.map((r) => {
          const s = byId.get(r.youtube_id);
          return (
            <li key={r.youtube_id} className="m-item">
              {/* la copertina apre il video su YouTube, per controllarlo prima di aggiungerlo */}
              <button
                type="button"
                className="cover m-cover wide yt-preview"
                title="Guarda il video su YouTube"
                onClick={() => openExternal(r.url)}
              >
                <img src={r.thumbnail} alt="" loading="lazy" />
                <span className="yt-play">
                  <Play size={16} fill="currentColor" />
                </span>
              </button>
              <div className="m-item-main">
                <div className="m-item-title full-title">{r.title}</div>
                <div className="m-item-sub ellipsis">
                  {r.channel} · {fmtTime(r.duration)}
                </div>
              </div>
              {s?.status === "ready" ? (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    safe(() => api.enqueue(s.id, name), addedMsg)
                  }
                >
                  <Check size={16} /> Aggiungi
                </button>
              ) : (
                <button className="btn btn-primary btn-sm" onClick={() => setImporting(r)}>
                  Aggiungi
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {results && results.length > 0 && search.canMore && (
        <div className="load-more">
          <button className="btn btn-ghost btn-block" onClick={search.loadMore} disabled={search.loadingMore}>
            {search.loadingMore ? <Loader2 size={16} className="spin" /> : <ChevronDown size={16} />} Carica altri risultati
          </button>
        </div>
      )}
      {importing && (
        <ImportSheet
          result={importing}
          onCancel={() => setImporting(null)}
          onConfirm={async (artist, title) => {
            const r = importing;
            await safe(async () => {
              await api.download(r, name, artist, title);
              setImporting(null);
            }, preparingMsg);
          }}
        />
      )}
    </div>
  );
}

/** Interruttore "ADMIN" (spento di default): acceso, chiede la password da amministratore. */
function AdminSwitch({
  on,
  name,
  unreachable = false,
  onLogin,
  onOff,
}: {
  on: boolean;
  name: string; // nome con cui si accede (lo vede il PC)
  unreachable?: boolean; // PC non raggiungibile: lo si dice subito nel popup
  onLogin: (password: string, name: string) => void;
  onOff: () => void;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="m-admin">
      <label className="m-switch">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => (e.target.checked ? setAsking(true) : onOff())}
        />
        <span className="m-switch-track" aria-hidden>
          <span className="m-switch-thumb" />
        </span>
        <span className="m-switch-label">ADMIN</span>
      </label>
      {asking && (
        <AdminPasswordDialog
          name={name}
          unreachable={unreachable}
          onClose={() => setAsking(false)}
          onSuccess={(pw) => {
            setAsking(false);
            onLogin(pw, name);
          }}
        />
      )}
    </div>
  );
}

/** Popup per la password da amministratore: si chiude da solo se è giusta, altrimenti lo dice. */
function AdminPasswordDialog({
  name,
  unreachable,
  onClose,
  onSuccess,
}: {
  name: string;
  unreachable: boolean;
  onClose: () => void;
  onSuccess: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!password || busy) return;
    if (unreachable) return setError(PC_UNREACHABLE);
    setBusy(true);
    setError("");
    try {
      await adminLogin(password, name);
      onSuccess(password);
    } catch (err: any) {
      setError(err.message || "Password errata");
      setBusy(false);
    }
  };
  // portale: il popup sta sopra tutto, anche sopra la scheda del profilo (fuori dal suo form)
  return createPortal(
    <div className="m-sheet m-pw-back" onClick={onClose}>
      <div
        className="m-sheet-card m-pw"
        role="dialog"
        aria-modal="true"
        aria-labelledby="m-pw-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="icon-btn m-pw-close" title="Chiudi" onClick={onClose}>
          <X size={20} />
        </button>
        <div className="m-sheet-title" id="m-pw-title">
          Accesso amministratore
        </div>
        <PasswordInput
          placeholder="Password amministratore"
          value={password}
          onChange={(v) => (setPassword(v), setError(""))}
          onEnter={submit}
          autoFocus
        />
        {error && <div className="m-admin-err">{error}</div>}
        <div className="m-sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Annulla
          </button>
          <button type="button" className="btn btn-primary" disabled={!password || busy} onClick={submit}>
            {busy ? <Loader2 size={18} className="spin" /> : "Accedi"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
