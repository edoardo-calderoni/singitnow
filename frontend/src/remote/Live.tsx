import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BarChart3, Clock, Headphones, Mic, Mic2, MicOff, Minus, Music, Pause, Play, Plus, RotateCcw, SkipForward, Sparkles, Square, Trophy, Users, Volume2, VolumeX, Wand2 } from "lucide-react";
import { api, Entry, LyricLine, PlaylistState } from "../shared/api";
import { Avatar } from "../shared/Avatar";
import { LivePlayer, playerTime } from "../shared/live";
import { Mode, useDj, useJukebox, useMode } from "../shared/mode";
import { activeIndex, switchTimes, wordFill } from "../shared/lyrics";
import { currentRemaining, entryStarts, fmtClock, fmtWait, queueTimeline, singersOf, singsIn, useTick } from "../shared/queue";
import { MIC_COLORS, micLabel, useMicCount, useMics, useMicSetter } from "../shared/mics";
import { useCompetition } from "../shared/competition";
import { correctionText, strengthLabel, useVoice, useVoiceSetter } from "../shared/voice";

export { entryStarts, fmtWait, useTick } from "../shared/queue";

export type Turn =
  | { kind: "stage" }
  | { kind: "next" }
  | { kind: "wait"; seconds: number; ahead: number }
  | { kind: "preparing"; seconds: number; ahead: number; first: boolean };

/** Quando tocca a `name`: il primo dei suoi brani in coda (o in preparazione), duetti compresi. */
export function turnFor(name: string, playlist: PlaylistState, player: LivePlayer): Turn | null {
  if (singsIn(playlist.now_playing, name)) return { kind: "stage" };
  const starts = entryStarts(playlist, player);
  const idx = playlist.entries.findIndex((e) => singsIn(e, name));
  if (idx >= 0) {
    if (idx === 0 && !playlist.now_playing) return { kind: "next" };
    return { kind: "wait", seconds: starts[idx]!, ahead: idx + (playlist.now_playing ? 1 : 0) };
  }
  const wi = playlist.waiting.findIndex((x) => x.singer === name);
  if (wi >= 0) {
    // in preparazione: riprende il suo turno se sarà pronto in tempo, altrimenti entra quando è pronto
    const tl = queueTimeline(playlist, player);
    const mine = tl.waiting[wi];
    const before =
      tl.entries.filter((s) => s < mine).length + tl.waiting.filter((s, i) => i !== wi && s < mine).length;
    return {
      kind: "preparing",
      seconds: mine,
      ahead: before + (playlist.now_playing ? 1 : 0),
      first: before === 0,
    };
  }
  return null;
}


/** «2 brani prima del tuo · il tuo brano è in preparazione» (senza mai «0 brani»). */
function waitDetails(turn: Turn): string {
  const parts: string[] = [];
  if ((turn.kind === "wait" || turn.kind === "preparing") && turn.ahead > 0)
    parts.push(turn.ahead === 1 ? "1 brano prima del tuo" : `${turn.ahead} brani prima del tuo`);
  if (turn.kind === "preparing") parts.push("il tuo brano è in preparazione");
  const s = parts.join(" · ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function TurnBanner({ turn, onAdd, onLyrics }: { turn: Turn | null; onAdd: () => void; onLyrics?: () => void }) {
  const jukebox = useJukebox();
  useTick(1000); // il conto alla rovescia scorre
  if (!turn) return null;
  let title: React.ReactNode;
  let sub: string;
  if (jukebox) {
    // Jukebox: nessun turno da cantare, solo quando parte il proprio brano
    if (turn.kind === "stage") {
      title = "Sta suonando il tuo brano 🎵";
      sub = "Tocca qui per vedere il testo";
    } else if (turn.kind === "next") {
      title = "Il tuo brano è il prossimo!";
      sub = "Parte appena finisce quello in corso";
    } else {
      title = (
        <>
          Il tuo brano partirà fra <span className="grad-text">{fmtWait(turn.seconds)}</span>
        </>
      );
      sub = waitDetails(turn);
    }
  } else if (turn.kind === "stage") {
    title = "È il tuo turno: sei sul palco!";
    sub = "Tocca qui per vedere il testo";
  } else if (turn.kind === "next") {
    title = "Sei il prossimo!";
    sub = "Preparati, tocca a te appena parte la musica";
  } else if (turn.kind === "preparing" && turn.first) {
    // il suo brano è il primo: conto alla rovescia preciso, preparazione compresa
    title = (
      <>
        Preparati a salire sul palco, il tuo brano è il prossimo fra:{" "}
        <span className="grad-text m-turn-clock">{fmtClock(turn.seconds)}</span>
      </>
    );
    sub = waitDetails(turn);
  } else {
    // in coda (o in preparazione con altri brani prima): conto alla rovescia in tempo reale
    title = (
      <>
        Salirai sul palco fra: <span className="grad-text m-turn-clock">{fmtClock(turn.seconds)}</span>
      </>
    );
    sub = waitDetails(turn);
  }
  // sul palco: tutta la scheda porta al testo; sul palco, da prossimo e con «Preparati a salire sul
  // palco» niente "+" per aggiungere altri brani
  const stage = turn.kind === "stage";
  const showAdd = !stage && turn.kind !== "next" && !(turn.kind === "preparing" && turn.first);
  return (
    <div
      className={`m-turn ${turn.kind} ${stage && onLyrics ? "clickable" : ""}`}
      onClick={stage ? onLyrics : undefined}
      role={stage && onLyrics ? "button" : undefined}
    >
      <div className="m-turn-icon">{stage ? <Mic2 size={22} /> : turn.kind === "next" ? <Sparkles size={22} /> : <Clock size={22} />}</div>
      <div className="m-turn-body">
        <div className="m-turn-title">{title}</div>
        <div className="m-turn-sub">{sub}</div>
      </div>
      {showAdd && (
        <button className="btn btn-ghost btn-sm" onClick={onAdd} title="Aggiungi un altro brano">
          <Plus size={16} />
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ tonalità consigliata
const keyText = (k: number) => `${Math.abs(k)} semiton${Math.abs(k) === 1 ? "o" : "i"} più ${k < 0 ? "bassa" : "alta"}`;

/**
 * «Adatta la tua tonalità»: quando SingITnow conosce la voce di chi canta (l'ha sentita in brani
 * precedenti) e per il suo prossimo brano (o quello che sta cantando) una tonalità diversa è più
 * comoda, un tocco la applica; un altro torna all'originale.
 */
export function MyKeyCard({ name, playlist }: { name: string; playlist: PlaylistState }) {
  const jukebox = useJukebox();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const me = name.trim().toLowerCase();
  const mine = [playlist.now_playing, ...playlist.entries].find(
    (e) => !!e && !e.partner && e.singer.trim().toLowerCase() === me,
  );
  const suggested = mine?.suggested_key ?? 0;
  if (jukebox || !mine || !suggested) return null;
  const adapted = (mine.play_key ?? 0) === suggested;
  const playing = mine.id === playlist.now_playing?.id;
  const set = (key?: number) => {
    setBusy(true);
    setError("");
    api
      .myKey(mine.id, name, key)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className={`m-keyfit ${adapted ? "on" : ""}`}>
      <div className="m-keyfit-icon">
        <Music size={20} />
      </div>
      <div className="m-keyfit-body">
        <div className="m-keyfit-title">
          {adapted ? "Tonalità adattata alla tua voce" : "C'è una tonalità più comoda per te"}
        </div>
        <div className="m-keyfit-sub">
          {mine.song?.title ? `«${mine.song.title}» ` : ""}
          {adapted ? `${playing ? "suona" : "partirà"} ${keyText(suggested)} dell'originale` : `ti verrebbe meglio ${keyText(suggested)}`}
        </div>
        {error && <div className="m-vol-err">{error}</div>}
      </div>
      {adapted ? (
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => set(0)}>
          Originale
        </button>
      ) : (
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => set()}>
          Adatta la tua tonalità
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ testo in tempo reale
export function LyricsTab({
  name,
  playlist,
  player,
}: {
  name: string;
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
      {/* copertina del disco come sfondo: sfocata e scurita, il testo resta leggibile */}
      <div className="m-lyrics-bg" aria-hidden key={now.song.id}>
        <div className="m-lyrics-bg-glow" style={{ backgroundImage: `url("${now.song.cover_url || now.song.thumbnail_url}")` }} />
        <img className="m-lyrics-bg-art" src={now.song.cover_url || now.song.thumbnail_url} alt="" />
      </div>
      <div className="m-lyrics-head">
        <img src={now.song.thumbnail_url} alt="" />
        <div className="ellipsis">
          <div className="m-item-title ellipsis">{now.song.title}</div>
          <div className="m-item-sub ellipsis">
            {now.song.artist}
            {now.singer && (
              <>
                {" "}
                · {jukebox ? "aggiunto da" : now.partner ? "duetto" : "canta"} <b>{jukebox ? now.singer : singersOf(now)}</b>
              </>
            )}
          </div>
        </div>
      </div>
      {!singsIn(now, name) && !jukebox && <ApplauseButton name={name} floating />}
      {!singsIn(now, name) && !jukebox && <ReactionBar name={name} floating />}
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
              {line.orig && <span className="m-lyric-orig">{line.orig}</span>}
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
/**
 * Amministratori: volume e muto dei microfoni con cui si canta (uno o due), regolati sul PC.
 * Non compare se il PC non ha microfoni collegati.
 */
export function MicSliders({ compact }: { compact?: boolean }) {
  const mics = useMics();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(""), 4000);
    return () => window.clearTimeout(id);
  }, [error]);
  const setMic = useMicSetter(setError);
  if (!mics?.length) return null;
  return (
    <>
      {mics.map((m) => (
        <div className={`m-vol m-mic ${compact ? "compact" : ""} ${m.muted ? "muted" : ""}`} key={m.index}>
          <button
            className={`icon-btn ${m.muted ? "danger" : ""}`}
            onClick={() => setMic(m.index, { muted: !m.muted })}
            title={m.muted ? "Riattiva il microfono" : "Silenzia il microfono"}
          >
            {m.muted ? <MicOff size={18} /> : <Mic2 size={18} />}
          </button>
          <div className="m-vol-main">
            <div className="m-vol-label">
              <span>{micLabel(m, mics.length)}</span>
              <b>{m.muted ? "Muto" : `${Math.round(m.volume * 100)}%`}</b>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={m.volume}
              disabled={m.muted}
              aria-label={`Volume ${micLabel(m, mics.length).toLowerCase()}`}
              style={{ ["--val" as string]: `${m.volume * 100}%` }}
              onChange={(e) => setMic(m.index, { volume: parseFloat(e.target.value) })}
            />
            {error && m.index === 0 && <div className="m-vol-err">{error}</div>}
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * Scheda «Competizione» nei Settaggi: interruttore (come sul PC) e pulsante per mostrare sulla TV
 * la classifica in tempo reale per qualche secondo. Solo in Karaoke (in Jukebox non si canta).
 */
export function CompetitionCard({ inline }: { inline?: boolean }) {
  const comp = useCompetition();
  const jukebox = useJukebox();
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!msg) return;
    const id = window.setTimeout(() => setMsg(""), 2500);
    return () => window.clearTimeout(id);
  }, [msg]);
  // es. «Nessun microfono rilevato…»: avviso in primo piano, l'interruttore resta spento
  const [notice, setNotice] = useState("");
  if (jukebox) return null;
  return (
    <div className={inline ? "m-comp m-comp-inline" : "m-mode m-comp"}>
      {notice &&
        createPortal(
          <div className="m-sheet" onClick={() => setNotice("")}>
            <div className="m-sheet-card m-notice" role="alertdialog" onClick={(e) => e.stopPropagation()}>
              <div className="m-notice-icon">{/microfono/i.test(notice) ? <MicOff size={26} /> : <Users size={26} />}</div>
              <p>{notice}</p>
              <button type="button" className="btn btn-primary btn-wide" onClick={() => setNotice("")}>
                Ok
              </button>
            </div>
          </div>,
          document.body,
        )}
      <div className="m-mode-label">Competizione</div>
      <label className="m-switch">
        <input
          type="checkbox"
          checked={comp.enabled}
          onChange={(e) =>
            api
              .setCompetition(e.target.checked, localStorage.getItem("sin.name") ?? "")
              .catch((err) => setNotice(err.message))
          }
        />
        <span className="m-switch-track" aria-hidden>
          <span className="m-switch-thumb" />
        </span>
        <span className="m-switch-label">{comp.enabled ? "Attiva" : "Spenta"}</span>
      </label>
      <div className="m-mode-hint">
        {comp.enabled
          ? "Conta la media dei voti d'intonazione di ciascuno; quando concludi la serata si premia il vincitore"
          : "Attivala per una classifica fra chi canta in questa sessione"}
      </div>
      {comp.enabled && (
        <button
          type="button"
          className="btn btn-primary btn-sm m-wifi-show"
          onClick={() =>
            api
              .showRanking()
              .then(() => setMsg("Classifica sulla TV per 10 secondi"))
              .catch((e) => setMsg(e.message))
          }
        >
          <Trophy size={15} /> Mostra la classifica sulla TV
        </button>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-sm m-wifi-show"
        onClick={() =>
          api
            .showStats()
            .then(() => setMsg("Statistiche della serata sulla TV"))
            .catch((e) => setMsg(e.message))
        }
      >
        <BarChart3 size={15} /> Mostra le statistiche sulla TV
      </button>
      {msg && <div className="m-admin-msg">{msg}</div>}
    </div>
  );
}

/**
 * Amministratori: autotune della voce (con la sua intensità). Con `full` anche la scelta di chi
 * gestisce la voce dei microfoni (Windows o SingITnow) e gli avvisi.
 */
export function AutotuneControl({ compact, full }: { compact?: boolean; full?: boolean }) {
  const voice = useVoice();
  const mics = useMics();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(""), 4000);
    return () => window.clearTimeout(id);
  }, [error]);
  const setVoice = useVoiceSetter(setError);
  const competition = useCompetition().enabled; // in gara niente autotune: si canta con la propria voce
  if (!voice || !mics?.length) return null;
  if (competition && !full) return null;
  return (
    <>
      {competition ? (
        <div className="m-mode-hint">Autotune non disponibile con la modalità competizione accesa</div>
      ) : (
      <div className={`m-vol m-autotune ${compact ? "compact" : ""} ${voice.autotune ? "on" : ""}`}>
        <button
          className={`icon-btn ${voice.autotune ? "on" : ""}`}
          onClick={() => setVoice({ autotune: !voice.autotune })}
          title={voice.autotune ? "Spegni l'autotune" : "Accendi l'autotune"}
        >
          <Wand2 size={18} />
        </button>
        <div className="m-vol-main">
          <div className="m-vol-label">
            <span>Autotune</span>
            <b>{voice.autotune ? strengthLabel(voice.strength) : "Spento"}</b>
          </div>
          {voice.autotune && (
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={voice.strength}
              aria-label="Intensità dell'autotune"
              style={{ ["--val" as string]: `${voice.strength * 100}%` }}
              onChange={(e) => setVoice({ strength: parseFloat(e.target.value) })}
            />
          )}
          {correctionText(voice) && <div className="m-autotune-live">{correctionText(voice)}</div>}
          {error && <div className="m-vol-err">{error}</div>}
        </div>
      </div>
      )}
      {/* la voce passa sempre da SingITnow: restano solo gli avvisi (problemi, voce doppia) */}
      {full && voice.engine && (voice.error || voice.listening.length > 0) && (
        <div className="m-voice">
          {voice.error && <div className="m-mode-hint">Problema con la voce: {voice.error}</div>}
          {voice.listening.length > 0 && (
            <div className="m-voice-warn">
              In Windows è ancora attivo «Ascolta questo dispositivo» su {voice.listening.join(", ")}: la voce si sente
              due volte. Disattivalo sul PC da Impostazioni audio → Microfono → Proprietà → Ascolto.
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Scheda «Microfoni» nei Settaggi: si regolano anche quando non sta suonando niente. */
export function MicCard() {
  const mics = useMics();
  return (
    <div className="m-mode m-mics">
      <div className="m-mode-label">Microfoni</div>
      {mics === null ? (
        <div className="m-mode-hint">Leggo i microfoni del PC…</div>
      ) : mics.length ? (
        <>
          <MicSliders compact />
          <AutotuneControl compact full />
        </>
      ) : (
        <div className="m-mode-hint">Nessun microfono collegato al PC</div>
      )}
    </div>
  );
}

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

/** Secondi alla fine del brano in corso se il prossimo in coda è di `name` (anche in duetto), altrimenti null. */
export function secondsToMyTurn(name: string, playlist: PlaylistState, player: LivePlayer): number | null {
  if (!playlist.now_playing || !singsIn(playlist.entries[0], name)) return null;
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
  // nell'app Android l'avviso «Tocca a te» (con vibrazione) arriva dalla notifica: la scheda non serve.
  // Su iPhone le pagine web non possono vibrare, quindi lì non compare mai: resta solo per chi usa
  // Chrome su Android senza l'app.
  if (!need || window.SingITnowApp) return null;
  return (
    <button
      className="m-vib"
      onClick={() => {
        vibrate([80]);
        setNeed(false);
      }}
    >
      📳 Tocca qui per attivare la vibrazione che ti avvertirà quando sarà il tuo turno.
    </button>
  );
}

// ------------------------------------------------------------------ passaggio del microfono
const PASS_AFTER_START = 12; // s: l'avviso «Passa il microfono» resta ancora così dopo che il brano dopo è partito

const sameName = (a: string | undefined, b: string) => !!a && !!b && a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** Microfono di `name` in un brano: 0 = rosso (chi ha prenotato), 1 = blu (chi si è unito in duetto). */
export function micOf(e: Pick<Entry, "singer" | "partner">, name: string): number {
  return sameName(e.partner, name) && !sameName(e.singer, name) ? 1 : 0;
}

export interface MicPass {
  done: Entry; // brano appena finito, in cui `name` cantava
  next: Entry; // brano dopo
  to: string; // a chi `name` passa il microfono
}

/**
 * A chi passare il microfono a fine brano. Chi aveva il rosso lo passa a chi ha prenotato il brano
 * dopo; chi aveva il blu (duetto, con due microfoni) lo passa solo se anche il brano dopo è un duetto,
 * a chi si è unito. Niente se il microfono resta in mano alla stessa persona.
 */
function passTarget(done: Entry, next: Entry, name: string, mics: number): string {
  const to = micOf(done, name) === 0 ? next.singer : mics >= 2 ? next.partner || "" : "";
  return to && !sameName(to, name) ? to : "";
}

/**
 * Passaggio del microfono per chi ha appena cantato: parte appena il brano finisce (mentre la TV
 * mostra i punteggi) oppure, se il brano è stato interrotto, quando parte quello dopo; dura finché il
 * brano dopo è partito da PASS_AFTER_START secondi.
 */
export function usePassMic(name: string, playlist: PlaylistState, player: LivePlayer, enabled: boolean): MicPass | null {
  useTick(500);
  const [pass, setPass] = useState<{ done: Entry; next: Entry; started: number | null } | null>(null);
  const now = playlist.now_playing;
  const first = playlist.entries[0] ?? null;
  const ended = enabled && !!now && !!first && singsIn(now, name) && currentRemaining(playlist, player) <= 1;
  const prev = useRef(now);
  useEffect(() => {
    const before = prev.current;
    prev.current = now;
    if (!enabled || !name) return setPass(null);
    if (now && before && now.id !== before.id) {
      // è partito un altro brano
      if (pass && pass.next.id === now.id) setPass({ ...pass, started: Date.now() });
      else if (singsIn(before, name)) setPass({ done: before, next: now, started: Date.now() }); // interrotto
      else setPass(null);
      return;
    }
    if (!now) {
      if (pass) setPass(null); // serata ferma
      return;
    }
    // brano finito, punteggi sulla TV: il brano dopo è il primo in coda (anche se lo spostano)
    if (ended && (pass?.done.id !== now.id || pass.next.id !== first!.id)) setPass({ done: now, next: first!, started: null });
  }, [now?.id, first?.id, ended, enabled, name]); // eslint-disable-line react-hooks/exhaustive-deps
  const mics = useMicCount(!!pass);
  if (!pass || (pass.started !== null && Date.now() - pass.started > PASS_AFTER_START * 1000)) return null;
  const to = passTarget(pass.done, pass.next, name, mics);
  return to ? { done: pass.done, next: pass.next, to } : null;
}

/** «Passa il microfono a …» a chi ha appena cantato (con vibrazione). */
export function PassMicAlert({ name, pass }: { name: string; pass: MicPass | null }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const vibrated = useRef<string | null>(null);
  // chi canta anche nel brano dopo lo legge nell'avviso «Tocca a te»
  const show = !!pass && !singsIn(pass.next, name) && dismissed !== pass.done.id;
  useEffect(() => {
    if (show && vibrated.current !== pass!.done.id) {
      vibrated.current = pass!.done.id;
      vibrate([300, 120, 300]);
    }
  }, [show, pass]);
  if (!show) return null;
  return (
    <div className="m-ready m-pass" role="alertdialog" aria-live="assertive">
      <div className="m-ready-card">
        <Avatar name={pass!.to} className="big m-pass-face" />
        <div className="m-ready-title">PASSA IL MICROFONO A</div>
        <div className="m-pass-name">{pass!.to}</div>
        {pass!.next.song && (
          <div className="m-ready-song">
            canta «{pass!.next.song.title}»{pass!.next.partner && ` in duetto`}
          </div>
        )}
        <button className="btn btn-primary" onClick={() => setDismissed(pass!.done.id)}>
          Fatto
        </button>
      </div>
    </div>
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
  pass,
}: {
  name: string;
  playlist: PlaylistState;
  player: LivePlayer;
  synced: boolean;
  onStage: () => void;
  /** anche chi canta adesso deve passare un microfono (duetto seguito da un altro duetto) */
  pass: MicPass | null;
}) {
  useTick(200);
  const remaining = secondsToMyTurn(name, playlist, player);
  const nextId = playlist.entries[0]?.id;
  const show = remaining !== null && remaining <= GET_READY;
  const zero = show && remaining! <= 1;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const mics = useMicCount(show);
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
  const stageId = singsIn(playlist.now_playing, name) ? playlist.now_playing!.id : null;
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
  const first = playlist.entries[0];
  // in duetto: con chi si canta (l'altro dei due)
  const mate = first?.partner ? (singsIn({ singer: first.singer }, name) ? first.partner : first.singer) : "";
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
        {mate && <div className="m-ready-duet">🎤 In duetto con {mate}</div>}
        {pass && singsIn(first, name) && (
          <div className="m-ready-duet">Prima passa il tuo microfono a {pass.to}</div>
        )}
        <div className={`m-ready-mic ${mics >= 2 ? `mic-${micOf(first!, name) ? "blue" : "red"}` : ""}`}>
          <Mic size={18} /> Prendi il microfono{mics >= 2 && ` ${MIC_COLORS[micOf(first!, name)]}`}
        </div>
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
const CLAP_MIN_GAP = 120; // ms tra due applausi dallo stesso telefono (il server ne accetta 16 ogni 2 s)

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

// ------------------------------------------------------------------ reazioni
export const REACTIONS = ["🔥", "😂", "😍", "🤘", "😮"];
const REACTION_MIN_GAP = 150; // ms fra due reazioni dallo stesso telefono (il server ne accetta 20 ogni 3 s)

/** Emoji da mandare a chi sta cantando: sulla TV volano con la propria foto. */
export function ReactionBar({ name, floating }: { name: string; floating?: boolean }) {
  const [pops, setPops] = useState<{ k: number; e: string }[]>([]);
  const last = useRef(0);
  const seq = useRef(0);
  const send = (emoji: string) => {
    const now = performance.now();
    if (now - last.current < REACTION_MIN_GAP) return;
    last.current = now;
    vibrate([10]);
    fetch("/api/reaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, emoji }),
    }).catch(() => {});
    const k = ++seq.current;
    setPops((p) => [...p.slice(-6), { k, e: emoji }]);
    window.setTimeout(() => setPops((p) => p.filter((x) => x.k !== k)), 900);
  };
  return (
    <div className={`m-react ${floating ? "floating" : ""}`}>
      {REACTIONS.map((e) => (
        <button key={e} type="button" className="m-react-btn" onClick={() => send(e)} aria-label={`Reazione ${e}`}>
          {e}
          {pops
            .filter((p) => p.e === e)
            .map((p) => (
              <span key={p.k} className="m-clap-pop">
                {e}
              </span>
            ))}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ comandi amministratore
/**
 * Comandi del brano in corso riservati agli amministratori: pausa/ripresa, stop,
 * ricomincia, brano successivo, volume generale e della voce, tonalità.
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
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(() => api.command("restart"), "Brano ricominciato")}>
          <RotateCcw size={15} /> Ricomincia
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => run(() => api.next(), "Brano successivo")}>
          <SkipForward size={15} /> Avanti
        </button>
      </div>
      <VocalSlider name={name} player={player} compact={compact} kind="volume" />
      {/* Jukebox: solo il volume generale, la voce resta quella originale */}
      {!jukebox && <VocalSlider name={name} player={player} compact={compact} />}
      {!jukebox && <KeyControl name={name} player={player} compact={compact} />}
      <MicSliders compact={compact} />
      {!jukebox && <AutotuneControl compact={compact} />}
      {msg && <div className="m-admin-msg">{msg}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ tonalità della base
const KEY_RANGE = 6;

/** Abbassa o alza la tonalità della base sulla TV, un semitono per tocco. */
function KeyControl({ name, player, compact }: { name: string; player: LivePlayer; compact?: boolean }) {
  const remote = player?.state.key ?? 0;
  // tocchi ravvicinati: si parte dall'ultimo valore inviato, non da quello (in ritardo) della TV
  const [local, setLocal] = useState<number | null>(null);
  const [error, setError] = useState("");
  const release = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(release.current), []);
  const value = local ?? remote;
  const step = (d: number) => {
    const k = Math.max(-KEY_RANGE, Math.min(KEY_RANGE, value + d));
    if (k === value) return;
    setLocal(k);
    window.clearTimeout(release.current);
    release.current = window.setTimeout(() => setLocal(null), 2500);
    api
      .command("key", k, name)
      .then(() => setError(""))
      .catch((e) => setError(e.message));
  };
  const label = value > 0 ? `+${value}` : value < 0 ? String(value) : "originale";
  return (
    <div className={`m-vol m-key ${compact ? "compact" : ""}`}>
      <button className="icon-btn" onClick={() => step(-1)} disabled={value <= -KEY_RANGE} title="Abbassa di un semitono">
        <Minus size={18} />
      </button>
      <div className="m-vol-main">
        <div className="m-vol-label">
          <span>Tonalità</span>
          <b>{label}</b>
        </div>
        {error && <div className="m-vol-err">{error}</div>}
      </div>
      <button className="icon-btn" onClick={() => step(1)} disabled={value >= KEY_RANGE} title="Alza di un semitono">
        <Plus size={18} />
      </button>
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
      step(dir);
    };
    // nell'app Android i tasti fisici del volume arrivano come evento "singitnow-volume"
    const onAppKey = (ev: Event) => step(Number((ev as CustomEvent).detail) || 0);
    const step = (dir: number) => {
      if (!dir) return;
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
    window.addEventListener("singitnow-volume", onAppKey);
    window.SingITnowApp?.setVolumeKeys(true); // l'app intercetta i tasti invece di cambiare il volume del telefono
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("singitnow-volume", onAppKey);
      window.SingITnowApp?.setVolumeKeys(false);
    };
  }, [active]);
}

// ------------------------------------------------------------------ modalità (solo amministratori)
/** Scelta Karaoke / Jukebox / DJ: vale per tutti, sulla TV e su ogni telefono. */
export function ModeSwitch() {
  const mode = useMode();
  const dj = useDj();
  const [error, setError] = useState("");
  // partecipanti collegati, tra cui scegliere il DJ della serata
  const [users, setUsers] = useState<string[]>([]);
  const loadUsers = () => api.users().then((r) => setUsers(r.users)).catch(() => {});
  useEffect(() => {
    if (mode === "dj") loadUsers();
  }, [mode]);
  const pick = (m: Mode) => {
    if (m === mode) return;
    api
      .setMode(m)
      .then(() => setError(""))
      .catch((e) => setError(e.message));
  };
  const options = Array.from(new Set([dj, ...users].filter(Boolean)));
  return (
    <div className="m-mode">
      <div className="m-mode-label">Modalità della serata</div>
      <div className="m-seg m-seg-3" role="radiogroup" aria-label="Modalità">
        <button type="button" role="radio" aria-checked={mode === "karaoke"} className={mode === "karaoke" ? "on" : ""} onClick={() => pick("karaoke")}>
          <Mic2 size={16} /> Karaoke
        </button>
        <button type="button" role="radio" aria-checked={mode === "jukebox"} className={mode === "jukebox" ? "on" : ""} onClick={() => pick("jukebox")}>
          <Music size={16} /> Jukebox
        </button>
        <button type="button" role="radio" aria-checked={mode === "dj"} className={mode === "dj" ? "on" : ""} onClick={() => pick("dj")}>
          <Headphones size={16} /> DJ
        </button>
      </div>
      <div className="m-mode-hint">
        {mode === "dj"
          ? "Voce originale, aggiunge brani solo il DJ della serata (e gli amministratori)"
          : mode === "jukebox"
            ? "Voce originale, ognuno aggiunge quanti brani vuole"
            : "Si canta a turno, un brano in coda per persona"}
      </div>
      {/* in Karaoke, sotto la modalità, l'interruttore della competizione (come sul PC) */}
      {mode === "karaoke" && <CompetitionCard inline />}
      {mode === "dj" && (
        <div className="field m-dj-field">
          <Headphones size={18} />
          <select
            value={dj}
            onFocus={loadUsers}
            onChange={(e) =>
              api
                .setDj(e.target.value)
                .then(() => setError(""))
                .catch((err) => setError(err.message))
            }
            aria-label="DJ della serata"
          >
            <option value="">{options.length ? "Solo gli Admin" : "Nessun partecipante collegato"}</option>
            {options.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && <div className="m-admin-err">{error}</div>}
    </div>
  );
}
