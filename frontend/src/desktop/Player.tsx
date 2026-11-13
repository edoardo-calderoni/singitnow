import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  AudioLines,
  Maximize2,
  Loader2,
  Minus,
  Plus,
  Maximize,
  Mic,
  Mic2,
  MicOff,
  Volume2,
  Wand2,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  X,
} from "lucide-react";
import { api, Entry, fmtTime, LyricLine, Song } from "../shared/api";
import { KaraokeEngine } from "../shared/engine";
import { Beats, getCued, introStart, lateEntry, longIntro, MIX_SECONDS, onCuedChange, planMix, PRELOAD_SECONDS, runMix, setCued } from "./mix";
import { LyricsView } from "./LyricsView";
import { Avatar } from "../shared/Avatar";
import { fmtClock, prepRemaining, singersOf, useTick } from "../shared/queue";
import { useJukebox, useMode } from "../shared/mode";
import { ModeSeg } from "./ModeSeg";
import { Note, PitchBar } from "./PitchBar";
import { enoughSung, PitchScore, results } from "./performance";
import { ResultItem, showResults } from "./ResultsPanel";
import { useCompetition } from "../shared/competition";
import { MicPitch, singingMics } from "./mic";
import { MIN_RECORD_SECONDS, PerformanceRecorder } from "./recorder";
import { isEveningLast } from "../shared/evening";
import { useSettings } from "../shared/settings";
import { setApplauseVolume } from "./Applause";
import { MIC_NAMES, micLabel, useMics, useMicSetter } from "../shared/mics";
import { correctionText, strengthLabel, useVoice, useVoiceSetter } from "../shared/voice";
import type { VoiceState } from "../shared/api";

const UPCOMING_WINDOW = 30; // secondi prima della fine in cui annunciare il prossimo brano
const BACK_TO_HOME = 8;
export const KEY_RANGE = 6; // semitoni massimi verso l'alto o verso il basso (come sul server) // a fine playlist: secondi di applausi prima di tornare alla schermata principale

function stored(key: string, def: number): number {
  const v = parseFloat(localStorage.getItem(key) ?? "");
  return isFinite(v) ? v : def;
}

declare global {
  interface Window {
    pywebview?: { api?: { toggle_fullscreen?: () => void; set_fullscreen?: (on: boolean) => void } };
  }
}

export function toggleFullscreen() {
  autoFullscreen = false; // da qui in poi decide l'utente
  if (window.pywebview?.api?.toggle_fullscreen) window.pywebview.api.toggle_fullscreen();
  else if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

/** true se lo schermo intero è stato attivato da un avvio automatico (va tolto a fine serata). */
let autoFullscreen = false;

/** Schermo intero sì/no (nella finestra nativa non serve un clic; nel browser può essere negato). */
/** Entra a schermo intero (comando di un amministratore dal telefono). */
export function enterFullscreen() {
  autoFullscreen = false;
  if (window.pywebview?.api?.set_fullscreen) window.pywebview.api.set_fullscreen(true);
  else if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
}

/** Esce dallo schermo intero (tasto Esc). */
export function exitFullscreen() {
  autoFullscreen = false;
  if (window.pywebview?.api?.set_fullscreen) window.pywebview.api.set_fullscreen(false);
  else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

export function setFullscreen(on: boolean) {
  if (on) autoFullscreen = true;
  else if (!autoFullscreen) return;
  else autoFullscreen = false;
  if (window.pywebview?.api?.set_fullscreen) window.pywebview.api.set_fullscreen(on);
  else if (on && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

/** Volume e muto dei microfoni (uno o due) con cui si canta: regolano il microfono in Windows. */
function MicMixers() {
  const mics = useMics();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(""), 4000);
    return () => window.clearTimeout(id);
  }, [error]);
  const setMic = useMicSetter(setError);
  const voice = useVoice();
  const setVoice = useVoiceSetter(setError);
  const competition = useCompetition().enabled; // in gara niente autotune: si canta con la propria voce
  if (!mics?.length) return null;
  const tuned = !!voice?.autotune;
  return (
    <div className="mic-row">
      <div className="controls-group mixers mic-mixers">
        {/* autotune: la voce passa dal motore audio di SingITnow e viene intonata sulla melodia del brano */}
        {voice && !competition && (
          <div className={`mixer autotune ${tuned ? "on" : ""}`} title="Corregge l'intonazione di chi canta verso la melodia del brano">
            <button
              className={`icon-btn ${tuned ? "on" : ""}`}
              title={tuned ? "Spegni l'autotune" : "Accendi l'autotune"}
              onClick={() => setVoice({ autotune: !tuned })}
            >
              <Wand2 size={18} />
            </button>
            <span className="mixer-label">Autotune</span>
            {tuned && (
              <>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={voice.strength}
                  style={{ ["--val" as string]: `${voice.strength * 100}%` }}
                  onChange={(e) => setVoice({ strength: parseFloat(e.target.value) })}
                />
                <span className="mixer-val autotune-val">{strengthLabel(voice.strength)}</span>
              </>
            )}
          </div>
        )}
        {mics.map((m) => (
          <div className={`mixer mic-mixer ${m.muted ? "muted" : ""}`} key={m.index} title={m.name}>
            <button
              className={`icon-btn ${m.muted ? "danger" : ""}`}
              title={m.muted ? "Riattiva il microfono" : "Silenzia il microfono"}
              onClick={() => setMic(m.index, { muted: !m.muted })}
            >
              {m.muted ? <MicOff size={18} /> : <Mic2 size={18} />}
            </button>
            <span className="mixer-label">{micLabel(m, mics.length)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={m.volume}
              disabled={m.muted}
              style={{ ["--val" as string]: `${m.volume * 100}%` }}
              onChange={(e) => setMic(m.index, { volume: parseFloat(e.target.value) })}
            />
            <span className="mixer-val">{m.muted ? "Muto" : `${Math.round(m.volume * 100)}%`}</span>
          </div>
        ))}
      </div>
      {error && <div className="mic-error">{error}</div>}
      {voice?.engine && <VoiceNotes voice={voice} />}
    </div>
  );
}

/** Stato della voce gestita da SingITnow: ritardo, problemi, voce doppia con Windows. */
function VoiceNotes({ voice }: { voice: VoiceState }) {
  return (
    <div className="voice-notes">
      {voice.error ? (
        <span className="mic-error">Voce: {voice.error}</span>
      ) : voice.running ? (
        correctionText(voice) && <span className="autotune-live">{correctionText(voice)}</span>
      ) : (
        <span className="muted">Avvio della voce…</span>
      )}
      {voice.listening.length > 0 && (
        <span className="voice-warn">
          In Windows è attivo «Ascolta questo dispositivo» su {voice.listening.join(", ")}: la voce si sente due volte.
          Disattivalo da Impostazioni audio → Microfono → Proprietà → Ascolto.
        </span>
      )}
    </div>
  );
}

interface Props {
  entry: Entry;
  next: Entry | undefined;
  /** coda finita ma c'è un brano prenotato ancora in preparazione: la TV lo aspetta */
  waitingNext?: { singer: string; song: Song | null };
  onClose: () => void;
  onNext: () => void;
  /** finestrella in basso a destra: il brano continua mentre si usa l'app */
  mini?: boolean;
  onMinimize?: () => void;
  onExpand?: () => void;
  /** modalità DJ: è ora di caricare il brano successivo (fermo, nascosto) per il mix in battuta */
  onPrepareMix?: () => void;
  /** il mix è partito: il successivo si sente (va avviato sul server) */
  onMixStart?: () => void;
  /** brano successivo caricato in anticipo e fermo, in attesa del mix */
  cued?: boolean;
  /** brano in uscita durante un mix: sfuma, poi chiama onGone */
  outgoing?: boolean;
  onGone?: () => void;
  /** brano entrato con un mix: il video compare in dissolvenza */
  mixIn?: boolean;
}

export function Player({ entry, next, waitingNext, onClose, onNext, mini = false, onMinimize, onExpand, onPrepareMix, onMixStart, cued = false, outgoing = false, onGone, mixIn = false }: Props) {
  // in attesa del mix o in uscita il brano non comanda niente: niente stato ai telefoni, tastiera, comandi
  const outgoingRef = useRef(outgoing);
  outgoingRef.current = outgoing;
  const cuedRef = useRef(cued);
  cuedRef.current = cued;
  const passive = useRef(false);
  passive.current = outgoing || cued;
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;
  const beatsRef = useRef<Beats | null>(null);
  const linesRef = useRef<LyricLine[] | null>(null);
  /**
   * Jukebox e DJ: l'introduzione strumentale lunga si salta, si parte poco prima della voce
   * (con una breve dissolvenza). In Karaoke no: l'introduzione serve a chi canta per prepararsi.
   */
  const skipIntro = (e: KaraokeEngine) => {
    if (!jukeboxRef.current) return;
    const voice = longIntro(linesRef.current, beatsRef.current);
    if (voice == null) return;
    e.seek(introStart(voice, beatsRef.current));
    e.fadeMaster(0, 0);
    e.fadeMaster(volumeRef.current, 1.5);
  };
  const song = entry.song!;
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<KaraokeEngine | null>(null);
  const [loading, setLoading] = useState(0);
  const [error, setError] = useState("");
  const [lines, setLines] = useState<LyricLine[]>([]);
  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(song.duration);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  // ogni brano parte con la voce originale a 0 (si canta sulla sola base); si alza a mano
  const [vocals, setVocals] = useState(0);
  useEffect(() => setVocals(0), [song.id]);
  // Jukebox: si ascolta il brano originale, voce sempre al massimo (la voce guida non si regola)
  const jukebox = useJukebox(); // anche in modalità DJ
  const mode = useMode();
  const jukeboxRef = useRef(jukebox);
  jukeboxRef.current = jukebox;
  // passaggio Jukebox -> Karaoke durante il brano: la voce guida riparte da 0 (si canta sulla base)
  const wasJukebox = useRef(jukebox);
  useEffect(() => {
    if (wasJukebox.current && !jukebox) setVocals(0);
    wasJukebox.current = jukebox;
  }, [jukebox]);
  const [volume, setVolume] = useState(() => stored("sin.volume", 1));
  // anticipo/ritardo del testo regolato in passato per questo brano (il controllo non è più nel player)
  const [offset] = useState(() => stored(`sin.offset.${song.id}`, 0));
  // controlli in basso: nascosti durante il brano (anche passando al successivo),
  // ricompaiono solo muovendo il mouse
  const [controls, setControls] = useState(false);

  // ------------------------------------------------------------ tonalità della base
  // ogni brano parte nella tonalità originale, oppure in quella scelta da chi canta («Adatta la tua
  // tonalità» dal telefono, o automatica dai Settaggi); − e + la spostano di un semitono alla volta
  const [startKey] = useState(() => (jukebox ? 0 : Math.max(-KEY_RANGE, Math.min(KEY_RANGE, Math.round(entry.play_key ?? 0)))));
  const [key, setKey] = useState(startKey);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState("");
  const appliedKey = useRef(startKey); // tonalità che sta suonando davvero (anche per le barre dell'intonazione)
  const changeKey = useCallback((k: number) => {
    setKey(Math.max(-KEY_RANGE, Math.min(KEY_RANGE, Math.round(k))));
  }, []);

  // ------------------------------------------------------------ intonazione (microfono del PC)
  const [pitchOn, setPitchOn] = useState(() => localStorage.getItem("sin.pitch") !== "0");
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [mics, setMics] = useState<MicPitch[]>([]);
  const [micError, setMicError] = useState("");
  const scoreRef = useRef<PitchScore[]>([]);
  // si riguarda quali microfoni ci sono quando se ne collega o scollega uno
  const [devicesRev, setDevicesRev] = useState(0);
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md) return;
    const on = () => setDevicesRev((r) => r + 1);
    md.addEventListener("devicechange", on);
    return () => md.removeEventListener("devicechange", on);
  }, []);
  // c'è almeno un microfono collegato? (si sa anche senza permesso; si ricontrolla quando se ne collega uno)
  const [hasMicInput, setHasMicInput] = useState(true);
  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => setHasMicInput(d.some((x) => x.kind === "audioinput")))
      .catch(() => {});
  }, [devicesRev]);
  // intonazione, voti, punteggi e classifica solo con la «Modalità competizione» accesa
  const competitionOn = useCompetition().enabled;
  const pitchActive = competitionOn && pitchOn && !jukebox && !!notes?.length && hasMicInput;
  useEffect(() => {
    localStorage.setItem("sin.pitch", pitchOn ? "1" : "0");
  }, [pitchOn]);
  useEffect(() => {
    setNotes(null);
    if (!song.media?.pitch) return;
    let alive = true;
    api
      .pitch(song.id)
      .then((p) => alive && setNotes(p.notes))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [song.id, song.media?.pitch]);
  // due microfoni collegati e duetto = due intonazioni; senza duetto conta solo il microfono rosso
  // (il blu si sente lo stesso alle casse, ma niente riga dell'intonazione né punteggio)
  const duetMics = !jukebox && !!entry.partner;
  useEffect(() => {
    if (!pitchActive) return;
    let alive = true;
    let started: MicPitch[] = [];
    setMicError("");
    (async () => {
      const first = new MicPitch();
      started = [first];
      await first.start(); // chiede il permesso: da qui in poi si vedono i nomi dei microfoni
      const ids = await singingMics().catch(() => [""]);
      if (ids.length > 1) {
        first.stop();
        const use = duetMics ? ids : ids.slice(0, 1); // il primo è il rosso
        started = use.map(() => new MicPitch());
        await Promise.all(started.map((m, i) => m.start(use[i])));
      }
      if (alive) setMics(started);
    })().catch(() => {
      if (!alive) return;
      // con due microfoni uno può non partire: si riprova con quello predefinito
      started.forEach((m) => m.stop());
      const m = new MicPitch();
      started = [m];
      m.start()
        .then(() => alive && setMics([m]))
        .catch(() => alive && setMicError("Microfono non disponibile"));
    });
    return () => {
      alive = false;
      started.forEach((m) => m.stop());
      setMics([]);
    };
  }, [pitchActive, devicesRev, duetMics]);
  const clock = useCallback(() => {
    const e = engineRef.current;
    return { t: e?.currentTime ?? 0, playing: !!e?.playing, outLatency: e?.outputLatency ?? 0 };
  }, []);
  // voto a fine brano: solo se il microfono era attivo e si è cantata almeno metà delle note
  const canScore = useRef(false);
  canScore.current = pitchActive && mics.length > 0;
  // con due microfoni: il rosso è di chi ha prenotato, il blu di chi si è unito in duetto
  // (in duetto il secondo è di chi si è unito)
  const partner = jukebox ? "" : entry.partner || "";
  const micLabels = [entry.singer || MIC_NAMES[0], partner || MIC_NAMES[1]];
  /**
   * Risultati di ogni microfono che ha cantato abbastanza (vuoto = niente pannello), con il voto già
   * salvato: la risposta porta la posizione in classifica e la classifica da mostrare dopo il voto.
   */
  const finalResults = (): ResultItem[] => {
    if (!canScore.current) return [];
    const duo = scoreRef.current.length > 1;
    const out: ResultItem[] = [];
    scoreRef.current.forEach((s, i) => {
      if (!enoughSung(s)) return; // non ha cantato abbastanza
      if (i > 0 && s.devN === 0) return; // il secondo microfono è rimasto muto
      const res = results(s);
      // duetto con un solo microfono: la voce è di entrambi, il voto va a tutti e due
      const singers = i > 0 ? [partner] : duo || !partner ? [entry.singer || ""] : [entry.singer, partner];
      const saved = Promise.all(
        singers.map((who) => api.addScore(song.id, who, res.score, duo ? micLabels[i] : "", entry.id).catch(() => null)),
      ).then((r) => r[0]);
      const name = i > 0 ? partner : duo || !partner ? entry.singer || "" : singersOf(entry);
      out.push({ name, label: duo ? micLabels[i] : "", results: res, saved });
    });
    return out;
  };
  const resultsRef = useRef(finalResults);
  resultsRef.current = finalResults;

  // ------------------------------------------------------------ estensione della voce
  // Karaoke, da soli: si misurano le note cantate davvero (anche senza Competizione) e a fine brano
  // si mandano al PC, che impara la voce di chi canta per consigliargli la tonalità più comoda.
  const rangeOn = !jukebox && !cued && !outgoing && !!entry.singer && !partner && !!notes?.length && hasMicInput;
  const rangeSamples = useRef<number[]>([]);
  const rangeSent = useRef(false);
  useEffect(() => {
    // con la Competizione le note cantate le raccoglie già la PitchBar (scoreRef)
    if (!rangeOn || pitchActive || !notes) return;
    let alive = true;
    let raf = 0;
    let tick = 0;
    const mic = new MicPitch();
    mic
      .start()
      .then(() => {
        const loop = () => {
          if (!alive) return;
          raf = requestAnimationFrame(loop);
          const heard = mic.read(); // una lettura per fotogramma (filtra i salti d'ottava)
          const e = engineRef.current;
          if (heard == null || !e?.playing || ++tick % 3) return; // ~20 campioni al secondo
          const tv = e.currentTime - mic.latency;
          // solo dove la melodia canta: niente rumori o chiacchiere fra una strofa e l'altra
          if (notes.some((n) => n[0] <= tv && tv <= n[1])) rangeSamples.current.push(heard);
        };
        if (alive) raf = requestAnimationFrame(loop);
      })
      .catch(() => {});
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      mic.stop();
    };
  }, [rangeOn, pitchActive, notes]);
  const sendRange = () => {
    if (rangeSent.current || !entry.singer || partner) return;
    const r = [...rangeSamples.current, ...(scoreRef.current[0]?.range ?? [])].sort((a, b) => a - b);
    if (r.length < 20 * 15) return; // meno di 15 secondi di voce: troppo poco
    rangeSent.current = true;
    const q = (p: number) => r[Math.floor(p * (r.length - 1))];
    api
      .voiceRange({ singer: entry.singer, song_id: song.id, lo: q(0.05), mid: q(0.5), hi: q(0.95), seconds: r.length / 20 })
      .catch(() => {});
  };
  const sendRangeRef = useRef(sendRange);
  sendRangeRef.current = sendRange;
  // il player si chiude prima della fine (Avanti, Stop): quello che si è cantato conta lo stesso
  useEffect(() => () => sendRangeRef.current(), []);
  // pannello finito: si passa al brano dopo (o alla schermata principale)
  // pannello dei risultati aperto da questo player (se il player si chiude prima, si chiude anche lui)
  const resultsShown = useRef(false);
  useEffect(
    () => () => {
      if (resultsShown.current) showResults(null);
    },
    [],
  );
  const finishResults = () => {
    if (!resultsShown.current) return;
    resultsShown.current = false;
    if (nextRef.current) onNextRef.current();
    else if (waitingRef.current) setEnded(true); // si aspetta il brano in preparazione, senza chiudere
    else onCloseRef.current();
  };
  const finishRef = useRef(finishResults);
  finishRef.current = finishResults;
  const hideTimer = useRef<number>(undefined);
  const nextRef = useRef(next);
  nextRef.current = next;
  const waitingRef = useRef(waitingNext);
  waitingRef.current = waitingNext;
  // sempre l'ultima versione: la fine del brano è gestita da un callback creato all'avvio
  const onNextRef = useRef(onNext);
  onNextRef.current = onNext;

  // ------------------------------------------------------------ registrazione dell'esibizione
  // voce dei microfoni + base, poi scaricabile dal telefono di chi canta (settaggio «Registra»)
  const recordSetting = useSettings()?.record ?? false;
  const recordOn = recordSetting && !jukebox && !!entry.singer && !outgoing;
  const recRef = useRef<PerformanceRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const recInfo = useRef({ songId: song.id, singer: entry.singer || "", partner });
  recInfo.current = { songId: song.id, singer: entry.singer || "", partner };
  /** Chiude la registrazione: se è abbastanza lunga la manda al PC, altrimenti la butta. */
  const finishRecording = useCallback((keep: boolean) => {
    const rec = recRef.current;
    recRef.current = null;
    setRecording(false);
    if (!rec) return;
    const seconds = rec.seconds;
    if (!keep || seconds < MIN_RECORD_SECONDS) return rec.cancel();
    const { songId, singer, partner } = recInfo.current;
    rec
      .stop()
      .then((blob) => blob && api.uploadRecording(blob, songId, seconds, singer, partner, rec.marks))
      .catch(() => {}); // una registrazione persa non deve disturbare la serata
  }, []);
  const finishRecRef = useRef(finishRecording);
  finishRecRef.current = finishRecording;
  useEffect(() => {
    const engine = engineRef.current;
    if (!recordOn) {
      if (recRef.current) finishRecording(false);
      return;
    }
    if (!engine) return;
    if (playing && !recRef.current) {
      const rec = new PerformanceRecorder(engine);
      recRef.current = rec;
      rec
        .start()
        .then(() => recRef.current === rec && setRecording(true))
        .catch(() => {
          if (recRef.current === rec) recRef.current = null; // microfono non disponibile: niente registrazione
          rec.cancel();
        });
    } else if (playing) recRef.current?.resume();
    else recRef.current?.pause();
  }, [playing, recordOn, finishRecording]);
  // il player si chiude (Stop, brano dopo): quello che si è cantato fin qui si tiene
  useEffect(() => () => finishRecRef.current(true), []);

  // Avviato da solo perché la playlist era ferma: schermo intero
  useEffect(() => {
    if (entry.auto) setFullscreen(true);
  }, [entry.id, entry.auto]);

  // ------------------------------------------------------------ caricamento
  useEffect(() => {
    const video = videoRef.current!;
    const engine = new KaraokeEngine(video);
    engineRef.current = engine;
    let raf = 0;
    let cancelled = false;

    engine.onEnded = () => {
      if (outgoingRef.current) {
        onGoneRef.current?.(); // mix finito: il brano in uscita sparisce
        return;
      }
      sendRangeRef.current();
      setPlaying(false);
      finishRecRef.current(true); // esibizione finita: la registrazione va al PC
      // si è cantato: pannello dei risultati, e il brano dopo parte solo qualche secondo dopo il voto
      const items = resultsRef.current();
      if (items.length) {
        resultsShown.current = true;
        showResults({
          items,
          title: song.title,
          artist: song.artist,
          isLast: () => isEveningLast(entry.id), // ultimo brano della serata in chiusura
          onLeave: () => finishRef.current(),
        });
        return;
      }
      if (nextRef.current) onNextRef.current();
      else setEnded(true);
    };

    // griglia del ritmo (mix in battuta in modalità DJ): se manca si mixa con una dissolvenza
    const beatsUrl = song.media!.beats;
    Promise.all([
      beatsUrl
        ? fetch(beatsUrl)
            .then((r) => (r.ok ? r.json() : null))
            .then((b) => void (beatsRef.current = b))
            .catch(() => {})
        : null,
      (appliedKey.current
        ? engine
            .load(
              `/media/${song.id}/key/${appliedKey.current}/instrumental.m4a`,
              `/media/${song.id}/key/${appliedKey.current}/vocals.m4a`,
              (p) => !cancelled && setLoading(p),
            )
            .catch(() => {
              // tonalità non disponibile: si parte nell'originale
              appliedKey.current = 0;
              if (!cancelled) setKey(0);
              return engine.load(song.media!.instrumental, song.media!.vocals, (p) => !cancelled && setLoading(p));
            })
        : engine.load(song.media!.instrumental, song.media!.vocals, (p) => !cancelled && setLoading(p))),
      api
        .lyrics(song.id)
        .then((l) => {
          if (cancelled) return;
          linesRef.current = l.lines;
          setLines(l.lines);
        })
        .catch(() => {}),
    ])
      .then(() => {
        if (cancelled) return;
        setDuration(engine.duration);
        setLoading(1);
        engine.setVocalVolume(jukeboxRef.current ? 1 : vocals);
        engine.setMasterVolume(volume);
        const loop = () => {
          setT(engine.currentTime);
          recRef.current?.track(engine.currentTime); // registrazione e brano a tempo (video col testo)
          setPlaying(engine.playing); // anche quando lo avvia il mix in battuta
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        if (cuedRef.current) {
          // in attesa del mix: resta fermo, lo farà partire il brano in corso al momento giusto
          setCued(entry.id, {
            engine,
            beats: beatsRef.current,
            volume: () => volumeRef.current,
            voice: longIntro(linesRef.current, beatsRef.current),
          });
          return;
        }
        // ?seek=120 nell'URL: parte da quel secondo (utile per test e prove)
        const startAt = parseFloat(new URLSearchParams(location.search).get("seek") ?? "");
        if (startAt > 0) engine.seek(startAt);
        else skipIntro(engine);
        engine.play().then(() => setPlaying(true));
      })
      .catch((e) => !cancelled && setError(String(e?.message ?? e)));

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      setCued(entry.id, null);
      engine.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id]);

  // Era in attesa del mix ma è partito senza (es. il brano prima è finito prima del mix, o è stato
  // avviato a mano): parte normalmente
  const wasCued = useRef(cued);
  useEffect(() => {
    const e = engineRef.current;
    if (wasCued.current && !cued && !outgoing && loading >= 1 && e && !e.playing && e.currentTime < 1) {
      e.setMasterVolume(volumeRef.current);
      skipIntro(e);
      e.play().then(() => setPlaying(true));
    }
    if (!cued) setCued(entry.id, null);
    wasCued.current = cued;
  }, [cued, outgoing, loading, entry.id]);

  useEffect(() => {
    engineRef.current?.setVocalVolume(jukebox ? 1 : vocals);
  }, [vocals, jukebox]);
  useEffect(() => {
    engineRef.current?.setMasterVolume(volume);
    setApplauseVolume(volume);
    localStorage.setItem("sin.volume", String(volume));
  }, [volume]);

  // Jukebox: si ascolta il brano originale
  useEffect(() => {
    if (jukebox) setKey(0);
  }, [jukebox]);

  // Cambio di tonalità: la versione trasposta si prepara sul server (qualche secondo la prima volta),
  // intanto si continua a sentire quella di prima. Più pressioni ravvicinate = un solo cambio.
  const wantedKey = useRef(0);
  wantedKey.current = key;
  const keyWorking = useRef(false);
  useEffect(() => {
    if (loading < 1 || key === appliedKey.current) return;
    const timer = window.setTimeout(async () => {
      if (keyWorking.current) return;
      keyWorking.current = true;
      setKeyBusy(true);
      setKeyError("");
      const url = (name: string, k: number) =>
        k === 0 ? song.media![name === "vocals" ? "vocals" : "instrumental"] : `/media/${song.id}/key/${k}/${name}.m4a`;
      try {
        while (wantedKey.current !== appliedKey.current) {
          const k = wantedKey.current;
          const e = engineRef.current;
          if (!e) break;
          await e.swap(url("instrumental", k), url("vocals", k));
          appliedKey.current = k;
        }
      } catch (err: any) {
        setKeyError(err?.message ?? "Cambio di tonalità non riuscito");
        setKey(appliedKey.current);
      } finally {
        keyWorking.current = false;
        setKeyBusy(false);
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [key, loading, song.id, song.media]);
  useEffect(() => {
    if (!keyError) return;
    const id = window.setTimeout(() => setKeyError(""), 4000);
    return () => window.clearTimeout(id);
  }, [keyError]);

  // ------------------------------------------------------------ posizione per i telefoni
  // (tempo di attesa "Il tuo turno sarà fra…" e testo in tempo reale sullo smartphone)
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const vocalsRef = useRef(vocals);
  vocalsRef.current = vocals;
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const keyRef = useRef(key);
  keyRef.current = key;
  const report = useCallback(() => {
    const e = engineRef.current;
    if (!e || !e.duration || passive.current) return;
    api
      .playerState({ song_id: song.id, t: e.currentTime, duration: e.duration, playing: e.playing, offset: offsetRef.current, vocals: jukeboxRef.current ? 1 : vocalsRef.current, volume: volumeRef.current, key: keyRef.current })
      .catch(() => {});
  }, [song.id]);
  useEffect(() => {
    if (loading < 1) return;
    report();
    const id = window.setInterval(report, 1000);
    return () => window.clearInterval(id);
  }, [loading, playing, offset, vocals, volume, key, jukebox, report]);

  // Brano finito con la coda vuota: qualche secondo di applausi, poi si torna alla schermata
  // principale. Se nel frattempo arriva una prenotazione, si riparte direttamente con quella.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [backIn, setBackIn] = useState(BACK_TO_HOME);
  // Coda finita ma un brano prenotato si sta ancora preparando: si resta qui con il conto alla
  // rovescia; appena è pronto entra in coda (diventa `next`) e parte da solo.
  const waitingFor = !!waitingNext;
  useEffect(() => {
    if (!ended) return;
    if (next) {
      const id = window.setTimeout(() => onNextRef.current(), 3000);
      return () => window.clearTimeout(id);
    }
    if (waitingFor) return;
    setBackIn(BACK_TO_HOME);
    const id = window.setInterval(() => setBackIn((s) => s - 1), 1000);
    return () => window.clearInterval(id);
  }, [ended, next, waitingFor]);
  useEffect(() => {
    if (ended && !next && !waitingFor && backIn <= 0) onCloseRef.current();
  }, [ended, next, waitingFor, backIn]);

  // ------------------------------------------------------------ comandi
  const toggle = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    e.toggle();
    setPlaying(e.playing);
    setEnded(false);
  }, []);

  // ogni salto ricalcola il mix in battuta (il punto d'attacco si sposta)
  const [seekRev, setSeekRev] = useState(0);
  const seek = useCallback(
    (to: number) => {
      setSeekRev((r) => r + 1);
      const e = engineRef.current;
      // un salto indietro "riapre" il brano finito; uno che resta alla fine no (es. → premuto di nuovo)
      if (!e || to < e.duration - 0.3) setEnded(false);
      e?.seek(to);
      setT(to);
      report();
    },
    [report],
  );

  const restart = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    setSeekRev((r) => r + 1);
    e.seek(0);
    if (!e.playing) e.play();
    setPlaying(true);
    setEnded(false);
  }, []);

  const wake = useCallback(() => {
    setControls(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControls(false), 3200);
  }, []);

  const miniRef = useRef(mini);
  miniRef.current = mini;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      // ridotto a finestrella si usa l'app: la tastiera non comanda il brano (né quello in uscita dal mix)
      if (miniRef.current || passive.current) return;
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || (tag === "INPUT" && (ev.target as HTMLInputElement).type !== "range")) return;
      const e = engineRef.current;
      switch (ev.key) {
        case " ":
          ev.preventDefault();
          toggle();
          break;
        case "ArrowRight":
          e && seek(Math.min(e.currentTime + 5, e.duration));
          break;
        case "ArrowLeft":
          e && seek(Math.max(e.currentTime - 5, 0));
          break;
        case "v":
        case "V":
          if (!jukeboxRef.current) setVocals((v) => (v > 0 ? 0 : 0.6));
          break;
        case "+":
        case "=":
          if (!jukeboxRef.current) setKey((k) => Math.min(KEY_RANGE, k + 1));
          break;
        case "-":
          if (!jukeboxRef.current) setKey((k) => Math.max(-KEY_RANGE, k - 1));
          break;
        // F / F11 / Esc (schermo intero) valgono in tutta l'app: li gestisce App
      }
    };
    // comandi dai telefoni
    const onCmd = (ev: Event) => {
      const { action, value } = (ev as CustomEvent).detail;
      const e = engineRef.current;
      if (!e || passive.current) return;
      if (action === "pause") e.pause();
      if (action === "resume") e.play();
      if (action === "toggle") e.toggle();
      if (action === "restart") restart();
      if (action === "vocals" && typeof value === "number" && !jukeboxRef.current) setVocals(Math.max(0, Math.min(1, value)));
      if (action === "volume" && typeof value === "number") setVolume(Math.max(0, Math.min(1, value)));
      if (action === "key" && typeof value === "number" && !jukeboxRef.current) changeKey(value);
      setTimeout(() => setPlaying(e.playing), 120);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("player-command", onCmd);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("player-command", onCmd);
    };
  }, [toggle, seek, restart, onClose, changeKey]);

  const lyricT = t + offset;
  const remaining = duration - t;

  // ------------------------------------------------------------ mix in battuta (DJ e Jukebox)
  // Con il prossimo brano pronto: a PRELOAD_SECONDS dalla fine lo si carica (fermo); appena è
  // caricato si programma il mix sul battito giusto (vedi mix.ts)
  // in Karaoke no: fra un cantante e l'altro c'è l'annuncio, gli applausi e il voto
  const djMix = jukebox && !cued && !outgoing && !!onPrepareMix && next?.song?.status === "ready" && duration > 40;
  const nextId = djMix ? next!.id : undefined;
  const prepared = useRef<string | null>(null);
  useEffect(() => {
    if (!nextId || loading < 1 || remaining > PRELOAD_SECONDS || prepared.current === nextId) return;
    prepared.current = nextId;
    onPrepareMix!();
  }, [nextId, loading, remaining, onPrepareMix]);

  const onMixStartRef = useRef(onMixStart);
  onMixStartRef.current = onMixStart;
  const [mixAt, setMixAt] = useState<number | null>(null); // posizione del brano in cui parte il mix
  const [cuedRev, setCuedRev] = useState(0);
  useEffect(() => onCuedChange(() => setCuedRev((r) => r + 1)), []);
  const cuedReady = !!getCued(nextId);
  useEffect(() => {
    const me = engineRef.current;
    const other = getCued(nextId);
    if (!nextId || !me || !other || !playing || loading < 1) return;
    const plan = planMix(beatsRef.current, me.duration, other.beats, other.voice);
    let start = me.timeAt(plan.outStart);
    if (start < me.now + 0.3) {
      // in ritardo (caricamento lento, salto in avanti): dissolvenza da subito, senza battuta
      const left = Math.max(1, me.duration - me.currentTime);
      plan.synced = false;
      plan.rate = 1;
      plan.length = Math.min(MIX_SECONDS, left);
      plan.inStart = lateEntry(other.beats, other.voice, plan.length); // senza silenzio e introduzione lunga
      start = me.now + 0.3;
    }
    setMixAt(me.currentTime + (start - me.now) * me.speed);
    const cancel = runMix({ engine: me, volume: volumeRef.current }, { engine: other.engine, volume: other.volume() }, plan, start, {
      onStart: () => onMixStartRef.current?.(),
      onEnd: () => onGoneRef.current?.(),
    });
    // pausa, salto o brano successivo cambiato prima dell'attacco: si annulla (e si riprogramma)
    return () => {
      cancel();
      setMixAt(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextId, playing, loading, cuedReady, cuedRev, seekRev]);

  // «Sta per iniziare»: col mix il prossimo parte quando inizia il mix
  const untilNext = mixAt !== null ? mixAt - t : remaining;
  const showUpcoming =
    !outgoing && !cued && !!next?.song && loading >= 1 && duration > UPCOMING_WINDOW && untilNext <= UPCOMING_WINDOW && untilNext > 0;

  return (
    <div
      className={`player ${mini ? "mini" : ""} ${outgoing ? "mix-out" : ""} ${cued ? "cued" : ""} ${mixIn ? "mix-in ready" : ""} ${!mini && (controls || (loading >= 1 && !playing && !ended)) ? "show-controls" : ""}`}
      onMouseMove={(ev) => {
        // il browser manda anche "movimenti" finti quando cambia ciò che sta sotto il mouse fermo
        if (!mini && (ev.movementX || ev.movementY)) wake();
      }}
      onClick={mini ? undefined : wake}
      onDoubleClick={mini ? onExpand : undefined}
    >
      <video ref={videoRef} className="player-video" src={song.media!.video} playsInline preload="auto" />
      <div className="player-shade" />
      {recording && !mini && (
        <div className="rec-badge" title="Si sta registrando l'esibizione (si scarica dal telefono di chi canta)">
          <span /> REC
        </div>
      )}

      {/* finestrella: al passaggio del mouse compaiono play/pausa, schermo intero e chiudi */}
      {mini && (
        <div className="mini-overlay" onClick={(e) => e.stopPropagation()}>
          <div className="mini-top">
            <div className="mini-title">
              <div className="ellipsis">{song.title}</div>
              <div className="mini-sub ellipsis">{entry.singer ? (jukebox ? `Aggiunto da ${entry.singer}` : `${partner ? "Duetto:" : "Canta"} ${singersOf(entry)}`) : song.artist}</div>
            </div>
            <button className="icon-btn" title="Torna a schermo intero" onClick={onExpand}>
              <Maximize2 size={17} />
            </button>
            <button className="icon-btn danger" title="Chiudi (ferma il brano)" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
          <div className="mini-center">
            <button className="play-btn" onClick={toggle} title="Play/Pausa" disabled={loading < 1}>
              {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
            </button>
          </div>
          <div className="mini-bottom">
            <span>{fmtTime(t)}</span>
            <div className="mini-progress">
              <div style={{ width: `${(t / (duration || 1)) * 100}%` }} />
            </div>
            <span>{fmtTime(duration)}</span>
          </div>
        </div>
      )}

      {/* intestazione */}
      <header className="player-top">
        <div className="now-singer">
          {/* torna alla schermata principale: il brano continua in una finestrella in basso a destra */}
          <button
            className="icon-btn glass player-back"
            title="Torna alla schermata principale (il brano continua)"
            onClick={(e) => {
              e.stopPropagation();
              onMinimize?.();
            }}
          >
            <ArrowLeft size={20} />
          </button>
          {entry.singer && <Avatar name={entry.singer} className="big" />}
          {entry.singer && partner && <Avatar name={partner} className="big duet-second" />}
          <div>
            <div className="eyebrow">
              {entry.singer ? (jukebox ? `Brano aggiunto da ${entry.singer}` : partner ? `Duetto: ${singersOf(entry)}` : `Richiesta da ${entry.singer}`) : mode === "dj" ? "DJ" : jukebox ? "Jukebox" : "Karaoke"}
            </div>
            <div className="player-title">
              {song.title} <span className="muted">· {song.artist}</span>
            </div>
          </div>
        </div>
        <button className="icon-btn glass" title="Chiudi" onClick={onClose}>
          <X size={20} />
        </button>
      </header>

      {/* annuncio prossimo brano */}
      {showUpcoming && (
        // in Karaoke niente conto alla rovescia: il pannello dei punteggi allunga comunque l'attesa
        <aside className="upcoming">
          <div className="cover" style={{ width: 64, height: 64 }}>
            <img src={next!.song!.thumbnail_url} alt="" />
          </div>
          <div className="upcoming-body">
            <div className="eyebrow">{jukebox ? "Sta per iniziare" : "Prossimo brano"}</div>
            <div className="upcoming-title ellipsis">{next!.song!.title}</div>
            <div className="upcoming-meta ellipsis">
              {next!.song!.artist}
              {next!.singer && (
                <>
                  {" "}
                  · {jukebox ? "aggiunto da" : next!.partner ? "duetto" : "richiesto da"} <Avatar name={next!.singer} className="xs inline" /> <b>{next!.singer}</b>
                  {!jukebox && next!.partner && (
                    <>
                      {" "}& <Avatar name={next!.partner} className="xs inline" /> <b>{next!.partner}</b>
                    </>
                  )}
                </>
              )}
            </div>
            {jukebox && (
              <div className="progress">
                <div style={{ width: `${Math.min(100, (1 - untilNext / UPCOMING_WINDOW) * 100)}%` }} />
              </div>
            )}
          </div>
          {jukebox && <div className="upcoming-count">{Math.max(0, Math.ceil(untilNext))}</div>}
        </aside>
      )}

      {/* testo */}
      {/* in Jukebox niente testo in sovraimpressione: si guarda il videoclip */}
      {loading >= 1 && !error && !jukebox && <LyricsView lines={lines} t={lyricT} />}

      {/* note da cantare e voce dal microfono */}
      {/* solo con un microfono funzionante: senza microfono il pannello resterebbe vuoto */}
      {loading >= 1 && !error && pitchActive && mics.length > 0 && !micError && (
        <PitchBar
          notes={notes!}
          mics={mics}
          labels={micLabels}
          micError={micError}
          clock={clock}
          scoreRef={scoreRef}
          keyShift={appliedKey}
        />
      )}

      {(keyBusy || keyError) && (
        <div className={`key-toast ${keyError ? "error" : ""}`}>
          {keyError || `Cambio tonalità (${key > 0 ? `+${key}` : key})…`}
        </div>
      )}

      {/* caricamento / errori / fine */}
      {loading < 1 && !error && (
        <div className="player-center">
          <div className="loader-ring" />
          <div className="loader-text">{jukebox ? "Preparo il brano…" : "Preparo il palco…"} {Math.round(loading * 100)}%</div>
        </div>
      )}
      {error && (
        <div className="player-center">
          <h2>Impossibile riprodurre il brano</h2>
          <p className="muted">{error}</p>
          <button className="btn btn-ghost" onClick={onClose}>
            Torna alla libreria
          </button>
        </div>
      )}
      {ended && !next && waitingNext && <WaitingNext waiting={waitingNext} />}
      {ended && !(!next && waitingNext) && (
        <div className="player-center finale">
          <div className="finale-emoji">{jukebox ? "🎵" : "👏"}</div>
          <h2 className="grad-text">
            {jukebox ? "Coda finita" : `Applausi${entry.singer ? ` per ${singersOf(entry)}` : ""}!`}
          </h2>
          <div className="row">
            <button className="btn btn-ghost" onClick={restart}>
              <RotateCcw size={16} /> {jukebox ? "Riascolta" : "Ricanta"}
            </button>
            <button className="btn btn-primary" onClick={onClose}>
              Torna alla libreria
            </button>
          </div>
          {!next && backIn > 0 && <p className="muted">Coda finita: torno alla schermata principale tra {backIn} s</p>}
        </div>
      )}

      {/* controlli */}
      <footer className="player-controls" onClick={(e) => e.stopPropagation()}>
        <div className="seek">
          <span>{fmtTime(t)}</span>
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.1}
            value={t}
            style={{ ["--val" as string]: `${(t / (duration || 1)) * 100}%` }}
            onChange={(e) => seek(parseFloat(e.target.value))}
          />
          <span>{fmtTime(duration)}</span>
        </div>
        <MicMixers />
        <div className="controls-row">
          <div className="controls-group">
            <button className="play-btn" onClick={toggle} title="Play/Pausa (Spazio)" disabled={loading < 1}>
              {playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
            </button>
            <button className="icon-btn" title="Ricomincia" onClick={restart}>
              <RotateCcw size={18} />
            </button>
            <button className="icon-btn" title="Brano successivo" onClick={onNext} disabled={!next}>
              <SkipForward size={18} />
            </button>
          </div>

          <div className="controls-group mixers">
            {!jukebox && (
            <label className="mixer" title="Voce originale (V)">
              <button className="icon-btn" onClick={() => setVocals((v) => (v > 0 ? 0 : 0.6))}>
                {vocals > 0 ? <Mic size={18} /> : <MicOff size={18} />}
              </button>
              <span className="mixer-label">Voce</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={vocals}
                style={{ ["--val" as string]: `${vocals * 100}%` }}
                onChange={(e) => setVocals(parseFloat(e.target.value))}
              />
              <span className="mixer-val">{Math.round(vocals * 100)}%</span>
            </label>
            )}
            {!jukebox && (
              <div className="mixer key-ctrl" title="Tonalità della base: abbassala o alzala per la tua voce (− / +)">
                <span className="mixer-label">Tonalità</span>
                <button className="icon-btn" onClick={() => setKey((k) => Math.max(-KEY_RANGE, k - 1))} disabled={key <= -KEY_RANGE}>
                  <Minus size={16} />
                </button>
                <span className={`key-val ${key ? "changed" : ""}`}>
                  {keyBusy ? <Loader2 size={15} className="spin" /> : key > 0 ? `+${key}` : key}
                </span>
                <button className="icon-btn" onClick={() => setKey((k) => Math.min(KEY_RANGE, k + 1))} disabled={key >= KEY_RANGE}>
                  <Plus size={16} />
                </button>
              </div>
            )}
            <label className="mixer" title="Volume generale (musica e voce)">
              <Volume2 size={18} className="muted" />
              <span className="mixer-label">Volume</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                style={{ ["--val" as string]: `${volume * 100}%` }}
                onChange={(e) => setVolume(parseFloat(e.target.value))}
              />
            </label>
          </div>

          <div className="controls-group">
            {/* senza un microfono funzionante l'intonazione non serve: niente pulsante */}
            {competitionOn && !jukebox && notes && notes.length > 0 && hasMicInput && !micError && (
              <button
                className={`icon-btn ${pitchOn ? "on" : ""}`}
                title={pitchOn ? "Nascondi le note dell'intonazione" : "Mostra le note dell'intonazione (microfono del PC)"}
                onClick={() => setPitchOn((v) => !v)}
              >
                <AudioLines size={18} />
              </button>
            )}
            <ModeSeg compact />
            <button className="icon-btn" title="Schermo intero (F)" onClick={toggleFullscreen}>
              <Maximize size={18} />
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * Coda finita mentre il brano prenotato si sta ancora preparando: conto alla rovescia sul tempo di
 * preparazione rimanente (la TV non torna alla schermata principale; il brano parte appena è pronto).
 */
function WaitingNext({ waiting }: { waiting: { singer: string; song: Song | null } }) {
  useTick(1000);
  const song = waiting.song;
  const left = prepRemaining(song);
  return (
    <div className="player-center waiting-next">
      <div className="eyebrow">Il prossimo brano si sta preparando</div>
      {song && (
        <div className="waiting-next-song">
          <img src={song.thumbnail_url} alt="" />
          <div>
            <div className="waiting-next-title">{song.title}</div>
            <div className="muted">{song.artist}</div>
          </div>
        </div>
      )}
      {waiting.singer && (
        <div className="waiting-next-singer">
          <Avatar name={waiting.singer} className="xs inline" /> canta <b>{waiting.singer}</b>
        </div>
      )}
      <div className="waiting-next-label">Si parte tra</div>
      <div className="waiting-next-clock grad-text">{fmtClock(left)}</div>
      <div className="waiting-next-bar">
        <div style={{ width: `${Math.round((song?.progress ?? 0) * 100)}%` }} />
      </div>
    </div>
  );
}
