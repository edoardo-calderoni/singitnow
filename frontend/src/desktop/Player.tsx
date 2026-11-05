import { useCallback, useEffect, useRef, useState } from "react";
import {
  Maximize,
  Mic,
  MicOff,
  Volume2,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Timer,
  X,
} from "lucide-react";
import { api, Entry, fmtTime, LyricLine } from "../shared/api";
import { KaraokeEngine } from "../shared/engine";
import { LyricsView } from "./LyricsView";
import { Avatar } from "../shared/Avatar";
import { useJukebox } from "../shared/mode";
import { ModeSeg } from "./ModeSeg";

const UPCOMING_WINDOW = 30; // secondi prima della fine in cui annunciare il prossimo brano
const BACK_TO_HOME = 8; // a fine playlist: secondi di applausi prima di tornare alla schermata principale

function stored(key: string, def: number): number {
  const v = parseFloat(localStorage.getItem(key) ?? "");
  return isFinite(v) ? v : def;
}

declare global {
  interface Window {
    pywebview?: { api?: { toggle_fullscreen?: () => void; set_fullscreen?: (on: boolean) => void } };
  }
}

function toggleFullscreen() {
  autoFullscreen = false; // da qui in poi decide l'utente
  if (window.pywebview?.api?.toggle_fullscreen) window.pywebview.api.toggle_fullscreen();
  else if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

/** true se lo schermo intero è stato attivato da un avvio automatico (va tolto a fine serata). */
let autoFullscreen = false;

/** Schermo intero sì/no (nella finestra nativa non serve un clic; nel browser può essere negato). */
export function setFullscreen(on: boolean) {
  if (on) autoFullscreen = true;
  else if (!autoFullscreen) return;
  else autoFullscreen = false;
  if (window.pywebview?.api?.set_fullscreen) window.pywebview.api.set_fullscreen(on);
  else if (on && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

interface Props {
  entry: Entry;
  next: Entry | undefined;
  onClose: () => void;
  onNext: () => void;
}

export function Player({ entry, next, onClose, onNext }: Props) {
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
  const [vocals, setVocals] = useState(() => stored("sin.vocals", 0.15));
  // Jukebox: si ascolta il brano originale, voce sempre al massimo (la voce guida non si regola)
  const jukebox = useJukebox();
  const jukeboxRef = useRef(jukebox);
  jukeboxRef.current = jukebox;
  // passaggio Jukebox -> Karaoke durante il brano: la voce guida riparte da 0 (si canta sulla base)
  const wasJukebox = useRef(jukebox);
  useEffect(() => {
    if (wasJukebox.current && !jukebox) setVocals(0);
    wasJukebox.current = jukebox;
  }, [jukebox]);
  const [volume, setVolume] = useState(() => stored("sin.volume", 1));
  const [offset, setOffset] = useState(() => stored(`sin.offset.${song.id}`, 0));
  const [controls, setControls] = useState(true);
  const hideTimer = useRef<number>(undefined);
  const nextRef = useRef(next);
  nextRef.current = next;
  // sempre l'ultima versione: la fine del brano è gestita da un callback creato all'avvio
  const onNextRef = useRef(onNext);
  onNextRef.current = onNext;

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
      setPlaying(false);
      if (nextRef.current) onNextRef.current();
      else setEnded(true);
    };

    Promise.all([
      engine.load(song.media!.instrumental, song.media!.vocals, (p) => !cancelled && setLoading(p)),
      api.lyrics(song.id).then((l) => !cancelled && setLines(l.lines)).catch(() => {}),
    ])
      .then(() => {
        if (cancelled) return;
        setDuration(engine.duration);
        setLoading(1);
        engine.setVocalVolume(jukeboxRef.current ? 1 : vocals);
        engine.setMasterVolume(volume);
        // ?seek=120 nell'URL: parte da quel secondo (utile per test e prove)
        const startAt = parseFloat(new URLSearchParams(location.search).get("seek") ?? "");
        if (startAt > 0) engine.seek(startAt);
        engine.play().then(() => setPlaying(true));
        const loop = () => {
          setT(engine.currentTime);
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      })
      .catch((e) => !cancelled && setError(String(e?.message ?? e)));

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      engine.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id]);

  useEffect(() => {
    engineRef.current?.setVocalVolume(jukebox ? 1 : vocals);
    localStorage.setItem("sin.vocals", String(vocals));
  }, [vocals, jukebox]);
  useEffect(() => {
    engineRef.current?.setMasterVolume(volume);
    localStorage.setItem("sin.volume", String(volume));
  }, [volume]);
  useEffect(() => {
    localStorage.setItem(`sin.offset.${song.id}`, String(offset));
  }, [offset, song.id]);

  // ------------------------------------------------------------ posizione per i telefoni
  // (tempo di attesa "Il tuo turno sarà fra…" e testo in tempo reale sullo smartphone)
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const vocalsRef = useRef(vocals);
  vocalsRef.current = vocals;
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const report = useCallback(() => {
    const e = engineRef.current;
    if (!e || !e.duration) return;
    api
      .playerState({ song_id: song.id, t: e.currentTime, duration: e.duration, playing: e.playing, offset: offsetRef.current, vocals: jukeboxRef.current ? 1 : vocalsRef.current, volume: volumeRef.current })
      .catch(() => {});
  }, [song.id]);
  useEffect(() => {
    if (loading < 1) return;
    report();
    const id = window.setInterval(report, 1000);
    return () => window.clearInterval(id);
  }, [loading, playing, offset, vocals, volume, jukebox, report]);

  // Brano finito con la coda vuota: qualche secondo di applausi, poi si torna alla schermata
  // principale. Se nel frattempo arriva una prenotazione, si riparte direttamente con quella.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [backIn, setBackIn] = useState(BACK_TO_HOME);
  useEffect(() => {
    if (!ended) return;
    if (next) {
      const id = window.setTimeout(() => onNextRef.current(), 3000);
      return () => window.clearTimeout(id);
    }
    setBackIn(BACK_TO_HOME);
    const id = window.setInterval(() => setBackIn((s) => s - 1), 1000);
    return () => window.clearInterval(id);
  }, [ended, next]);
  useEffect(() => {
    if (ended && !next && backIn <= 0) onCloseRef.current();
  }, [ended, next, backIn]);

  // ------------------------------------------------------------ comandi
  const toggle = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    e.toggle();
    setPlaying(e.playing);
    setEnded(false);
  }, []);

  const seek = useCallback(
    (to: number) => {
      engineRef.current?.seek(to);
      setT(to);
      setEnded(false);
      report();
    },
    [report],
  );

  const restart = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
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

  useEffect(() => {
    wake();
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement)?.tagName === "INPUT" && (ev.target as HTMLInputElement).type !== "range") return;
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
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "Escape":
          if (!document.fullscreenElement) onClose();
          break;
      }
      wake();
    };
    // comandi dai telefoni
    const onCmd = (ev: Event) => {
      const { action, value } = (ev as CustomEvent).detail;
      const e = engineRef.current;
      if (!e) return;
      if (action === "pause") e.pause();
      if (action === "resume") e.play();
      if (action === "toggle") e.toggle();
      if (action === "restart") restart();
      if (action === "vocals" && typeof value === "number" && !jukeboxRef.current) setVocals(Math.max(0, Math.min(1, value)));
      if (action === "volume" && typeof value === "number") setVolume(Math.max(0, Math.min(1, value)));
      setTimeout(() => setPlaying(e.playing), 120);
      wake();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("player-command", onCmd);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("player-command", onCmd);
    };
  }, [toggle, seek, restart, wake, onClose]);

  const lyricT = t + offset;
  const remaining = duration - t;
  const showUpcoming = !!next?.song && loading >= 1 && duration > UPCOMING_WINDOW && remaining <= UPCOMING_WINDOW;

  return (
    <div className={`player ${controls || !playing ? "show-controls" : ""}`} onMouseMove={wake} onClick={wake}>
      <video ref={videoRef} className="player-video" src={song.media!.video} playsInline preload="auto" />
      <div className="player-shade" />

      {/* intestazione */}
      <header className="player-top">
        <div className="now-singer">
          {entry.singer && <Avatar name={entry.singer} className="big" />}
          <div>
            <div className="eyebrow">
              {entry.singer ? (jukebox ? `Brano aggiunto da ${entry.singer}` : `Ora canta ${entry.singer}`) : jukebox ? "Jukebox" : "Karaoke"}
            </div>
            <div className="player-title">
              {song.title} <span className="muted">· {song.artist}</span>
            </div>
          </div>
        </div>
        <button className="icon-btn glass" title="Chiudi (Esc)" onClick={onClose}>
          <X size={20} />
        </button>
      </header>

      {/* annuncio prossimo brano */}
      {showUpcoming && (
        <aside className="upcoming">
          <div className="cover" style={{ width: 64, height: 64 }}>
            <img src={next!.song!.thumbnail_url} alt="" />
          </div>
          <div className="upcoming-body">
            <div className="eyebrow">Sta per iniziare</div>
            <div className="upcoming-title ellipsis">{next!.song!.title}</div>
            <div className="upcoming-meta ellipsis">
              {next!.song!.artist}
              {next!.singer && (
                <>
                  {" "}
                  · {jukebox ? "aggiunto da" : "canta"} <Avatar name={next!.singer} className="xs inline" /> <b>{next!.singer}</b>
                </>
              )}
            </div>
            <div className="progress">
              <div style={{ width: `${Math.min(100, (1 - remaining / UPCOMING_WINDOW) * 100)}%` }} />
            </div>
          </div>
          <div className="upcoming-count">{Math.max(0, Math.ceil(remaining))}</div>
        </aside>
      )}

      {/* testo */}
      {/* in Jukebox niente testo in sovraimpressione: si guarda il videoclip */}
      {loading >= 1 && !error && !jukebox && <LyricsView lines={lines} t={lyricT} />}

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
      {ended && (
        <div className="player-center finale">
          <div className="finale-emoji">{jukebox ? "🎵" : "👏"}</div>
          <h2 className="grad-text">
            {jukebox ? "Coda finita" : `Applausi${entry.singer ? ` per ${entry.singer}` : ""}!`}
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
              <span className="mixer-label">Voce guida</span>
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
            <ModeSeg compact />
            {!jukebox && (
            <div className="offset" title="Anticipa o ritarda il testo rispetto alla musica">
              <Timer size={16} className="muted" />
              <button className="icon-btn" onClick={() => setOffset((o) => +(o - 0.1).toFixed(2))}>
                −
              </button>
              <span>{offset > 0 ? "+" : ""}{offset.toFixed(1)}s</span>
              <button className="icon-btn" onClick={() => setOffset((o) => +(o + 0.1).toFixed(2))}>
                +
              </button>
            </div>
            )}
            <button className="icon-btn" title="Schermo intero (F)" onClick={toggleFullscreen}>
              <Maximize size={18} />
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
