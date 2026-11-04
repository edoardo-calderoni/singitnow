import { useCallback, useEffect, useRef, useState } from "react";
import {
  Maximize,
  Mic,
  MicOff,
  Music2,
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

const UPCOMING_WINDOW = 30; // secondi prima della fine in cui annunciare il prossimo brano

function stored(key: string, def: number): number {
  const v = parseFloat(localStorage.getItem(key) ?? "");
  return isFinite(v) ? v : def;
}

declare global {
  interface Window {
    pywebview?: { api?: { toggle_fullscreen?: () => void } };
  }
}

function toggleFullscreen() {
  if (window.pywebview?.api?.toggle_fullscreen) window.pywebview.api.toggle_fullscreen();
  else if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
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
  const [music, setMusic] = useState(() => stored("sin.music", 1));
  const [offset, setOffset] = useState(() => stored(`sin.offset.${song.id}`, 0));
  const [controls, setControls] = useState(true);
  const hideTimer = useRef<number>(undefined);
  const nextRef = useRef(next);
  nextRef.current = next;

  // ------------------------------------------------------------ caricamento
  useEffect(() => {
    const video = videoRef.current!;
    const engine = new KaraokeEngine(video);
    engineRef.current = engine;
    let raf = 0;
    let cancelled = false;

    engine.onEnded = () => {
      setPlaying(false);
      if (nextRef.current) onNext();
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
        engine.setVocalVolume(vocals);
        engine.setMusicVolume(music);
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
    engineRef.current?.setVocalVolume(vocals);
    localStorage.setItem("sin.vocals", String(vocals));
  }, [vocals]);
  useEffect(() => {
    engineRef.current?.setMusicVolume(music);
    localStorage.setItem("sin.music", String(music));
  }, [music]);
  useEffect(() => {
    localStorage.setItem(`sin.offset.${song.id}`, String(offset));
  }, [offset, song.id]);

  // ------------------------------------------------------------ comandi
  const toggle = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    e.toggle();
    setPlaying(e.playing);
    setEnded(false);
  }, []);

  const seek = useCallback((to: number) => {
    engineRef.current?.seek(to);
    setT(to);
    setEnded(false);
  }, []);

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
          setVocals((v) => (v > 0 ? 0 : 0.6));
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
      if (action === "vocals" && typeof value === "number") setVocals(Math.max(0, Math.min(1, value)));
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
          <div className="avatar big">{(entry.singer || "?").slice(0, 1).toUpperCase()}</div>
          <div>
            <div className="eyebrow">{entry.singer ? `Ora canta ${entry.singer}` : "Karaoke"}</div>
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
              {next!.singer && <> · canta <b>{next!.singer}</b></>}
            </div>
            <div className="progress">
              <div style={{ width: `${Math.min(100, (1 - remaining / UPCOMING_WINDOW) * 100)}%` }} />
            </div>
          </div>
          <div className="upcoming-count">{Math.max(0, Math.ceil(remaining))}</div>
        </aside>
      )}

      {/* testo */}
      {loading >= 1 && !error && <LyricsView lines={lines} t={lyricT} />}

      {/* caricamento / errori / fine */}
      {loading < 1 && !error && (
        <div className="player-center">
          <div className="loader-ring" />
          <div className="loader-text">Preparo il palco… {Math.round(loading * 100)}%</div>
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
          <div className="finale-emoji">👏</div>
          <h2 className="grad-text">Applausi{entry.singer ? ` per ${entry.singer}` : ""}!</h2>
          <div className="row">
            <button className="btn btn-ghost" onClick={restart}>
              <RotateCcw size={16} /> Ricanta
            </button>
            <button className="btn btn-primary" onClick={onClose}>
              Torna alla libreria
            </button>
          </div>
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
            <label className="mixer" title="Volume base musicale">
              <Music2 size={18} className="muted" />
              <span className="mixer-label">Musica</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={music}
                style={{ ["--val" as string]: `${music * 100}%` }}
                onChange={(e) => setMusic(parseFloat(e.target.value))}
              />
            </label>
          </div>

          <div className="controls-group">
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
            <button className="icon-btn" title="Schermo intero (F)" onClick={toggleFullscreen}>
              <Maximize size={18} />
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
