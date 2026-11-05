import { useEffect, useMemo, useRef, useState } from "react";
import { Clock, Mic, Mic2, MicOff, Music, Pause, Play, Plus, QrCode, SkipForward, Sparkles, Square, Volume2, VolumeX } from "lucide-react";
import { api, LyricLine, PlaylistState } from "../shared/api";
import { LivePlayer, playerTime } from "../shared/live";
import { Mode, useJukebox, useMode } from "../shared/mode";
import { activeIndex, switchTimes, wordFill } from "../shared/lyrics";

/** Pausa stimata tra un brano e il successivo (caricamento audio sulla TV). */
const GAP = 6;

/** Ridisegna il componente ogni `ms` millisecondi (per i conti alla rovescia). */
export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => set((n) => n + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

/** Secondi che mancano alla fine del brano in corso sulla TV. */
function currentRemaining(playlist: PlaylistState, player: LivePlayer): number {
  const now = playlist.now_playing;
  if (!now?.song) return 0;
  if (player && player.state.song_id === now.song.id) {
    return Math.max(0, (player.state.duration || now.song.duration) - playerTime(player));
  }
  return now.song.duration; // il player non ha ancora comunicato: brano appena partito
}

/**
 * Tra quanti secondi inizierà ogni brano in coda (stessa posizione di playlist.entries).
 * Assume che la coda venga suonata in ordine, una canzone dopo l'altra.
 */
export function entryStarts(playlist: PlaylistState, player: LivePlayer): number[] {
  let t = playlist.now_playing ? currentRemaining(playlist, player) + GAP : 0;
  return playlist.entries.map((e) => {
    const start = t;
    t += (e.song?.duration ?? 0) + GAP;
    return start;
  });
}

export type Turn =
  | { kind: "stage" }
  | { kind: "next" }
  | { kind: "wait"; seconds: number; ahead: number }
  | { kind: "preparing"; seconds: number; ahead: number };

/** Quando tocca a `name`: il primo dei suoi brani in coda (o in preparazione). */
export function turnFor(name: string, playlist: PlaylistState, player: LivePlayer): Turn | null {
  if (playlist.now_playing?.singer === name) return { kind: "stage" };
  const starts = entryStarts(playlist, player);
  const idx = playlist.entries.findIndex((e) => e.singer === name);
  if (idx >= 0) {
    if (idx === 0 && !playlist.now_playing) return { kind: "next" };
    return { kind: "wait", seconds: starts[idx]!, ahead: idx + (playlist.now_playing ? 1 : 0) };
  }
  const w = playlist.waiting.find((x) => x.singer === name);
  if (w) {
    // entrerà in coda in fondo, quando l'elaborazione sarà finita
    const last = playlist.entries.at(-1);
    const endOfQueue = last
      ? starts.at(-1)! + (last.song?.duration ?? 0) + GAP
      : playlist.now_playing
        ? currentRemaining(playlist, player) + GAP
        : 0;
    return {
      kind: "preparing",
      seconds: Math.max(endOfQueue, w.song?.eta ?? 0),
      ahead: playlist.entries.length + (playlist.now_playing ? 1 : 0),
    };
  }
  return null;
}

export function fmtWait(s: number): string {
  if (s < 60) return "meno di un minuto";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function TurnBanner({ turn, onAdd }: { turn: Turn | null; onAdd: () => void }) {
  const jukebox = useJukebox();
  if (!turn) return null;
  let title: React.ReactNode;
  let sub: string;
  if (jukebox) {
    // Jukebox: nessun turno da cantare, solo quando parte il proprio brano
    if (turn.kind === "stage") {
      title = "Sta suonando il tuo brano 🎵";
      sub = "Segui il testo nella scheda Testo";
    } else if (turn.kind === "next") {
      title = "Il tuo brano è il prossimo!";
      sub = "Parte appena finisce quello in corso";
    } else {
      title = (
        <>
          Il tuo brano partirà fra <span className="grad-text">{fmtWait(turn.seconds)}</span>
        </>
      );
      sub =
        (turn.ahead === 1 ? "1 brano prima del tuo" : `${turn.ahead} brani prima del tuo`) +
        (turn.kind === "preparing" ? " · il tuo brano è in preparazione" : "");
    }
  } else if (turn.kind === "stage") {
    title = "È il tuo turno: sei sul palco! 🎤";
    sub = "Guarda il testo nella scheda Testo";
  } else if (turn.kind === "next") {
    title = "Sei il prossimo!";
    sub = "Preparati, tocca a te appena parte la musica";
  } else {
    title = (
      <>
        Il tuo turno sarà fra <span className="grad-text">{fmtWait(turn.seconds)}</span>
      </>
    );
    sub =
      (turn.ahead === 1 ? "1 brano prima del tuo" : `${turn.ahead} brani prima del tuo`) +
      (turn.kind === "preparing" ? " · il tuo brano è in preparazione" : "");
  }
  return (
    <div className={`m-turn ${turn.kind}`}>
      <div className="m-turn-icon">{turn.kind === "stage" ? <Mic2 size={22} /> : turn.kind === "next" ? <Sparkles size={22} /> : <Clock size={22} />}</div>
      <div className="m-turn-body">
        <div className="m-turn-title">{title}</div>
        <div className="m-turn-sub">{sub}</div>
      </div>
      <button className="btn btn-ghost btn-sm" onClick={onAdd} title="Aggiungi un altro brano">
        <Plus size={16} />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ testo in tempo reale
export function LyricsTab({
  name,
  isAdmin,
  playlist,
  player,
}: {
  name: string;
  isAdmin: boolean;
  playlist: PlaylistState;
  player: LivePlayer;
}) {
  const now = playlist.now_playing;
  const jukebox = useJukebox();
  const songId = now?.song?.status === "ready" ? now.song.id : null;
  const [lines, setLines] = useState<LyricLine[] | null>(null);
  const [t, setT] = useState(0);
  const playerRef = useRef(player);
  playerRef.current = player;

  useEffect(() => {
    setLines(null);
    if (!songId) return;
    let cancelled = false;
    api
      .lyrics(songId)
      .then((l) => !cancelled && setLines(l.lines))
      .catch(() => !cancelled && setLines([]));
    return () => {
      cancelled = true;
    };
  }, [songId]);

  // Orologio locale "morbido": avanza col tempo reale e si riallinea alla TV accelerando o
  // rallentando leggermente, senza mai tornare indietro. Gli aggiornamenti della TV arrivano
  // ogni secondo con ritardi di rete variabili: saltarci sopra farebbe arretrare il colore.
  useEffect(() => {
    let raf = 0;
    let local = 0;
    let song = "";
    let last = performance.now();
    const loop = () => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      const p = playerRef.current;
      if (p) {
        const target = playerTime(p);
        const err = target - local;
        if (p.state.song_id !== song || Math.abs(err) > 1.5) {
          local = target; // brano nuovo, salto o ripresa: riallineamento immediato
          song = p.state.song_id;
        } else if (p.state.playing) {
          // velocità tra 0.85x e 1.15x: recupera lo scarto in un paio di secondi
          local += dt * (1 + Math.max(-0.15, Math.min(0.15, err * 0.6)));
        } else if (err > 0) {
          local = target; // in pausa: mai indietro
        }
        setT(local + p.state.offset);
      } else setT(0);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const times = useMemo(() => (lines ? switchTimes(lines) : []), [lines]);
  const synced = !!player && player.state.song_id === songId;
  const active = synced ? activeIndex(times, t) : -1;

  // tiene la riga attiva al centro dello schermo
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${Math.max(active, 0)}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active]);

  if (!now?.song) {
    return (
      <div className="empty">
        <h3>Nessun brano in corso</h3>
        <p>Quando sulla TV parte una canzone, qui vedrai il testo in tempo reale.</p>
      </div>
    );
  }
  return (
    <div className="m-lyrics-wrap">
      <div className="m-lyrics-head">
        <img src={now.song.thumbnail_url} alt="" />
        <div className="ellipsis">
          <div className="m-item-title ellipsis">{now.song.title}</div>
          <div className="m-item-sub ellipsis">
            {now.song.artist}
            {now.singer && (
              <>
                {" "}
                · {jukebox ? "aggiunto da" : "canta"} <b>{now.singer}</b>
              </>
            )}
          </div>
        </div>
      </div>
      {isAdmin && <AdminControls name={name} player={player} compact />}
      {now.singer !== name && !jukebox && <ApplauseButton name={name} floating />}
      {lines === null ? (
        <div className="empty">
          <p>Carico il testo…</p>
        </div>
      ) : lines.length === 0 ? (
        <div className="empty">
          <h3>Testo non disponibile</h3>
          <p>Per questo brano non è stato trovato il testo.</p>
        </div>
      ) : (
        <div className="m-lyrics" ref={listRef}>
          {lines.map((line, i) => (
            <p key={i} data-i={i} className={`m-lyric ${i === active ? "current" : i < active ? "past" : ""}`}>
              {i === active
                ? line.words.map((w, k) => (
                    <span key={k} className="m-lyric-word" style={{ ["--p" as string]: `${(wordFill(w, t) * 100).toFixed(1)}%` }}>
                      {w.t}{" "}
                    </span>
                  ))
                : line.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ volume voce guida
/**
 * Slider del volume della sola voce guida (solo amministratori).
 * Durante il trascinamento invia al massimo un comando ogni 120 ms; il valore mostrato
 * torna a seguire la TV poco dopo che il dito si è fermato.
 */
export function VocalSlider({
  name,
  player,
  compact,
  kind = "vocals",
}: {
  name: string;
  player: LivePlayer;
  compact?: boolean;
  kind?: "vocals" | "volume";
}) {
  const isMaster = kind === "volume";
  const remote = (isMaster ? player?.state.volume : player?.state.vocals) ?? (isMaster ? 1 : 0);
  const [local, setLocal] = useState<number | null>(null);
  const [error, setError] = useState("");
  const lastSent = useRef(0);
  const pending = useRef<number | undefined>(undefined);
  const release = useRef<number | undefined>(undefined);
  const value = local ?? remote;

  const send = (v: number) => {
    lastSent.current = performance.now();
    api
      .command(kind, v, name)
      .then(() => setError(""))
      .catch((e) => setError(e.message));
  };
  const change = (v: number) => {
    setLocal(v);
    window.clearTimeout(pending.current);
    window.clearTimeout(release.current);
    const wait = 120 - (performance.now() - lastSent.current);
    if (wait <= 0) send(v);
    else pending.current = window.setTimeout(() => send(v), wait);
    release.current = window.setTimeout(() => setLocal(null), 1500);
  };
  useEffect(
    () => () => {
      window.clearTimeout(pending.current);
      window.clearTimeout(release.current);
    },
    [],
  );

  return (
    <div className={`m-vol ${compact ? "compact" : ""}`}>
      <button
        className="icon-btn"
        onClick={() => change(value > 0 ? 0 : isMaster ? 1 : 0.6)}
        title={value > 0 ? (isMaster ? "Silenzia" : "Togli la voce") : isMaster ? "Riattiva l'audio" : "Rimetti la voce"}
      >
        {isMaster ? (
          value > 0 ? <Volume2 size={18} /> : <VolumeX size={18} />
        ) : value > 0 ? (
          <Mic size={18} />
        ) : (
          <MicOff size={18} />
        )}
      </button>
      <div className="m-vol-main">
        <div className="m-vol-label">
          <span>{isMaster ? "Volume generale" : "Volume voce"}</span>
          <b>{Math.round(value * 100)}%</b>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={value}
          aria-label={isMaster ? "Volume generale" : "Volume della voce guida"}
          style={{ ["--val" as string]: `${value * 100}%` }}
          onChange={(e) => change(parseFloat(e.target.value))}
        />
        {error && <div className="m-vol-err">{error}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ "Fra poco tocca a te"
export const GET_READY = 30; // secondi di preavviso (come l'annuncio "Sta per iniziare" sulla TV)

/** Secondi alla fine del brano in corso se il prossimo in coda è di `name`, altrimenti null. */
export function secondsToMyTurn(name: string, playlist: PlaylistState, player: LivePlayer): number | null {
  if (!playlist.now_playing || playlist.entries[0]?.singer !== name) return null;
  return currentRemaining(playlist, player);
}

let vibrationBlocked = false; // il browser ha rifiutato l'ultima vibrazione
const blockedListeners = new Set<() => void>();

/** Fa vibrare il telefono. Restituisce false se il browser lo impedisce (iPhone, pagina mai toccata…). */
export function vibrate(pattern: number[]): boolean {
  let ok = false;
  try {
    ok = !!navigator.vibrate?.(pattern); // su iPhone il browser non lo consente
  } catch {
    ok = false;
  }
  if (typeof navigator.vibrate === "function" && vibrationBlocked !== !ok) {
    vibrationBlocked = !ok;
    blockedListeners.forEach((l) => l());
  }
  return ok;
}

/** Android fa vibrare una pagina solo dopo che l'utente l'ha toccata almeno una volta. */
export function vibrationNeedsTap(): boolean {
  if (typeof navigator.vibrate !== "function") return false;
  const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  return vibrationBlocked || (!!ua && !ua.hasBeenActive);
}

export function EnableVibration() {
  const [need, setNeed] = useState(vibrationNeedsTap);
  useEffect(() => {
    const l = () => setNeed(vibrationNeedsTap());
    blockedListeners.add(l);
    return () => void blockedListeners.delete(l);
  }, []);
  if (!need) return null;
  return (
    <button
      className="m-vib"
      onClick={() => {
        vibrate([80]);
        setNeed(false);
      }}
    >
      📳 Tocca qui per attivare la vibrazione quando è il tuo turno
    </button>
  );
}

/**
 * Avviso a tutto schermo negli ultimi 30 secondi prima del proprio turno (con vibrazione),
 * e passaggio automatico alla scheda Testo quando il proprio brano parte.
 */
export function GetReadyAlert({
  name,
  playlist,
  player,
  synced,
  onStage,
}: {
  name: string;
  playlist: PlaylistState;
  player: LivePlayer;
  synced: boolean;
  onStage: () => void;
}) {
  useTick(200);
  const remaining = secondsToMyTurn(name, playlist, player);
  const nextId = playlist.entries[0]?.id;
  const show = remaining !== null && remaining <= GET_READY;
  const zero = show && remaining! <= 1;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const alerted = useRef<string | null>(null);
  const alertedZero = useRef<string | null>(null);

  // allo scadere del timer: vibrazione lunga
  useEffect(() => {
    if (zero && nextId && alertedZero.current !== nextId) {
      alertedZero.current = nextId;
      vibrate([800, 200, 800]);
    }
  }, [zero, nextId]);

  // una vibrazione quando compare l'avviso (una sola volta per prenotazione)
  useEffect(() => {
    if (show && nextId && alerted.current !== nextId) {
      alerted.current = nextId;
      vibrate([400, 150, 400, 150, 400]);
    }
  }, [show, nextId]);

  // inizio del proprio brano: vibrazione e scheda Testo
  const stageId = playlist.now_playing?.singer === name ? playlist.now_playing.id : null;
  const onStageRef = useRef(onStage);
  onStageRef.current = onStage;
  const lastStage = useRef<string | null>(null);
  const primed = useRef(false);
  useEffect(() => {
    if (!synced) return;
    if (!primed.current) {
      // primi dati dopo l'apertura: il proprio brano può essere già in corso, non è un "inizio"
      primed.current = true;
      lastStage.current = stageId;
      return;
    }
    if (stageId && stageId !== lastStage.current) {
      // "TOCCA A TE": se allo scadere del timer non è partita (la TV ha cambiato brano prima), parte ora
      if (alertedZero.current !== stageId) {
        alertedZero.current = stageId;
        vibrate([800, 200, 800]);
      }
      onStageRef.current();
    }
    lastStage.current = stageId;
  }, [stageId, synced]);

  if (!show || (dismissed === nextId && !zero)) return null;
  const secs = Math.max(0, Math.ceil(remaining!));
  const song = playlist.entries[0]?.song;
  return (
    <div className="m-ready" role="alertdialog" aria-live="assertive">
      <div className="m-ready-card">
        <div className="m-ready-icon">
          <Mic2 size={34} />
        </div>
        <div className="m-ready-title">{zero ? "TOCCA A TE! 🎤" : "FRA POCO TOCCA A TE, PREPARATI!"}</div>
        {song && (
          <div className="m-ready-song">
            {song.title}
            {song.artist && <span> · {song.artist}</span>}
          </div>
        )}
        <div className="m-ready-count">{zero ? "VAI!" : secs}</div>
        <EnableVibration />
        <div className="progress m-ready-bar">
          <div style={{ width: `${Math.min(100, (1 - remaining! / GET_READY) * 100)}%` }} />
        </div>
        {!zero && (
          <button className="btn btn-ghost" onClick={() => setDismissed(nextId ?? null)}>
            Ok, sono pronto
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ applausi
const CLAP_MIN_GAP = 160; // ms tra due applausi dallo stesso telefono (il server ne accetta 8 ogni 2 s)

/** Pulsante "Applaudi": ogni tocco manda un applauso alla TV (si può toccare a raffica). */
export function ApplauseButton({ name, floating }: { name: string; floating?: boolean }) {
  const [pops, setPops] = useState<number[]>([]);
  const last = useRef(0);
  const seq = useRef(0);

  const clap = () => {
    const now = performance.now();
    if (now - last.current < CLAP_MIN_GAP) return;
    last.current = now;
    vibrate([15]); // conferma al tatto (e sblocca le vibrazioni del "tocca a te")
    fetch("/api/applause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => {});
    const k = ++seq.current;
    setPops((p) => [...p.slice(-8), k]);
    window.setTimeout(() => setPops((p) => p.filter((x) => x !== k)), 900);
  };

  return (
    <button type="button" className={`m-clap ${floating ? "floating" : ""}`} onClick={clap} aria-label="Applaudi">
      <span className="m-clap-icon">👏</span>
      {!floating && <span>Applaudi</span>}
      {pops.map((k) => (
        <span key={k} className="m-clap-pop">
          👏
        </span>
      ))}
    </button>
  );
}

// ------------------------------------------------------------------ comandi amministratore
/**
 * Comandi del brano in corso riservati agli amministratori: pausa/ripresa, stop,
 * brano successivo, volume generale e della voce, QR code d'ingresso sulla TV.
 */
export function AdminControls({ name, player, compact }: { name: string; player: LivePlayer; compact?: boolean }) {
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!msg) return;
    const id = window.setTimeout(() => setMsg(""), 2500);
    return () => window.clearTimeout(id);
  }, [msg]);
  const run = (fn: () => Promise<unknown>, ok = "") =>
    fn()
      .then(() => ok && setMsg(ok))
      .catch((e) => setMsg(e.message));
  const paused = player?.state.playing === false;
  const jukebox = useJukebox();
  return (
    <div className={`m-admin-ctrl ${compact ? "compact" : ""}`}>
      <div className="m-admin-btns">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(() => api.command("toggle"))}>
          {paused ? <Play size={15} /> : <Pause size={15} />} {paused ? "Riprendi" : "Pausa"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(() => api.stop(), "Brano fermato")}>
          <Square size={15} /> Stop
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(() => api.next(), "Brano successivo")}>
          <SkipForward size={15} /> Avanti
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => run(() => api.showQr(), "QR code sulla TV per 10 secondi")}
        >
          <QrCode size={15} /> QR
        </button>
      </div>
      <VocalSlider name={name} player={player} compact={compact} kind="volume" />
      {/* Jukebox: solo il volume generale, la voce resta quella originale */}
      {!jukebox && <VocalSlider name={name} player={player} compact={compact} />}
      {msg && <div className="m-admin-msg">{msg}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ tasti volume del telefono
const VOLUME_KEYS: Record<string, number> = {
  AudioVolumeUp: 1,
  VolumeUp: 1,
  AudioVolumeDown: -1,
  VolumeDown: -1,
};
const VOLUME_STEP = 0.05;

/**
 * Amministratori: i tasti fisici volume su/giù regolano il volume generale della TV.
 * Funziona solo dove il browser passa quei tasti alla pagina (molti browser per
 * smartphone li tengono per sé e regolano solo il volume del telefono).
 */
export function useVolumeKeys(isAdmin: boolean, player: LivePlayer) {
  const target = useRef<number | null>(null);
  const last = useRef(0);
  const current = player?.state.volume ?? 1;
  const currentRef = useRef(current);
  currentRef.current = current;
  const active = isAdmin && !!player;
  useEffect(() => {
    if (!active) return;
    const onKey = (ev: KeyboardEvent) => {
      const dir = VOLUME_KEYS[ev.key];
      if (!dir) return;
      ev.preventDefault();
      // pressioni ravvicinate: si parte dall'ultimo valore inviato, non da quello (in ritardo) della TV
      const base = target.current !== null && performance.now() - last.current < 1500 ? target.current : currentRef.current;
      const v = Math.round(Math.max(0, Math.min(1, base + dir * VOLUME_STEP)) * 100) / 100;
      target.current = v;
      last.current = performance.now();
      flush();
    };
    // un invio alla volta: con pressioni rapide la TV riceve i valori in ordine e l'ultimo vince
    let busy = false;
    let sent: number | null = null;
    const flush = () => {
      if (busy || target.current === null || target.current === sent) return;
      busy = true;
      const v = target.current;
      api
        .command("volume", v)
        .catch(() => {})
        .finally(() => {
          sent = v;
          busy = false;
          flush();
        });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}

// ------------------------------------------------------------------ modalità (solo amministratori)
/** Scelta Karaoke / Jukebox: vale per tutti, sulla TV e su ogni telefono. */
export function ModeSwitch() {
  const mode = useMode();
  const [error, setError] = useState("");
  const pick = (m: Mode) => {
    if (m === mode) return;
    api
      .setMode(m)
      .then(() => setError(""))
      .catch((e) => setError(e.message));
  };
  return (
    <div className="m-mode">
      <div className="m-mode-label">Modalità della serata</div>
      <div className="m-seg" role="radiogroup" aria-label="Modalità">
        <button type="button" role="radio" aria-checked={mode === "karaoke"} className={mode === "karaoke" ? "on" : ""} onClick={() => pick("karaoke")}>
          <Mic2 size={16} /> Karaoke
        </button>
        <button type="button" role="radio" aria-checked={mode === "jukebox"} className={mode === "jukebox" ? "on" : ""} onClick={() => pick("jukebox")}>
          <Music size={16} /> Jukebox
        </button>
      </div>
      <div className="m-mode-hint">
        {mode === "jukebox"
          ? "Voce originale, ognuno aggiunge quanti brani vuole"
          : "Si canta a turno, un brano in coda per persona"}
      </div>
      {error && <div className="m-admin-err">{error}</div>}
    </div>
  );
}
