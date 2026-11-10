import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as RMouseEvent, PointerEvent as RPointerEvent, ReactElement, WheelEvent as RWheelEvent } from "react";
import { Check, Hand, Loader2, Mic, Music, Pause, Play, RotateCcw, Trash2, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { api, Song } from "../shared/api";
import { activeIndex, switchTimes, wordFill } from "../shared/lyrics";
import {
  clone,
  deleteLine,
  deleteWord,
  EdLine,
  moveWord,
  restoreLine,
  setWord,
  shiftFrom,
  shiftLine,
  tapLine,
  tapWord,
  withIds,
} from "./timing";

/** Tempo con i decimi: 1:05.3 */
function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

type Drag = {
  kind: "start" | "end" | "word" | "line";
  i: number;
  j: number;
  x0: number;
  base: EdLine[];
  moved: boolean;
};
type Tap = "off" | "lines" | "words";
type Sel = { i: number; j: number | null };
/** menu del tasto destro: su una riga (elenco o barra viola) o su una parola */
type Menu = { x: number; y: number; i: number; j: number | null };

const RATES = [1, 0.75, 0.5];
const LANE_LINE = 22; // altezza della corsia delle righe
const LANE_WORD = 46; // altezza della corsia delle parole
const WAVE = 96; // altezza della forma d'onda

/**
 * Editor dei tempi del testo (solo dal PC): si ascolta il brano (voce isolata o brano intero, anche
 * rallentato), si vede la colorazione come sullo schermo e si correggono i tempi
 * - al volo: durante la riproduzione INVIO segna l'attacco della prossima riga (o parola);
 * - sulla linea del tempo: le parole sono blocchi sopra la forma d'onda della voce, si trascinano i
 *   bordi (inizio/fine) o la parola intera; la barra della riga sposta tutta la riga.
 * Le righe toccate diventano «corrette a mano»: le correzioni automatiche non le cambiano più.
 */
export function TimingEditor({ song, onClose, onToast }: { song: Song; onClose: () => void; onToast: (m: string) => void }) {
  const [lines, setLines] = useState<EdLine[] | null>(null);
  const [original, setOriginal] = useState<EdLine[]>([]);
  const [env, setEnv] = useState<{ hop: number; env: number[] } | null>(null);
  const [history, setHistory] = useState<EdLine[][]>([]);
  const [sel, setSel] = useState<Sel>({ i: 0, j: null });
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [source, setSource] = useState<"voice" | "song">("voice");
  const [rate, setRate] = useState(1);
  const [zoom, setZoom] = useState(140); // pixel al secondo
  const [tap, setTap] = useState<Tap>("off");
  const [tapAt, setTapAt] = useState<{ i: number; j: number }>({ i: 0, j: 0 });
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState({ left: 0, width: 1000 });
  const [menu, setMenu] = useState<Menu | null>(null);

  const voiceRef = useRef<HTMLAudioElement>(null);
  const songRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const duration = song.duration || 0;

  useEffect(() => {
    api
      .lyrics(song.id)
      .then((l) => {
        const ls = withIds(l.lines);
        setLines(clone(ls));
        setOriginal(clone(ls));
      })
      .catch((e) => onToast(e.message));
    api
      .voiceEnvelope(song.id)
      .then(setEnv)
      .catch(() => setEnv({ hop: 0.02, env: [] }));
  }, [song.id, onToast]);

  const dirty = useMemo(() => history.length > 0, [history]);

  // --------------------------------------------------------------- riproduzione
  const media = () => [voiceRef.current, songRef.current, videoRef.current].filter(Boolean) as HTMLMediaElement[];

  useEffect(() => {
    // voce isolata, oppure voce + base (il brano intero)
    if (songRef.current) songRef.current.muted = source === "voice";
  }, [source]);
  useEffect(() => {
    for (const m of media()) m.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const v = voiceRef.current;
      if (v) {
        const now = v.currentTime;
        setT(now);
        // la base e il video seguono la voce
        for (const m of [songRef.current, videoRef.current]) {
          if (m && !v.paused && Math.abs(m.currentTime - now) > 0.08) m.currentTime = now;
        }
        if (v.paused !== !playing) setPlaying(!v.paused);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const seek = useCallback((to: number) => {
    const x = Math.max(0, Math.min(to, duration || to));
    for (const m of media()) m.currentTime = x;
    setT(x);
  }, [duration]);

  const toggle = useCallback(() => {
    const v = voiceRef.current;
    if (!v) return;
    if (v.paused) {
      const now = v.currentTime;
      for (const m of media()) {
        m.currentTime = now;
        m.playbackRate = rate;
        m.play().catch(() => {});
      }
    } else for (const m of media()) m.pause();
  }, [rate]);

  // la linea del tempo segue il punto di ascolto
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing || drag.current) return;
    const x = t * zoom;
    if (x < el.scrollLeft + el.clientWidth * 0.1 || x > el.scrollLeft + el.clientWidth * 0.7) {
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.3);
    }
  }, [t, zoom, playing]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const upd = () => setView({ left: el.scrollLeft, width: el.clientWidth });
    upd();
    el.addEventListener("scroll", upd, { passive: true });
    window.addEventListener("resize", upd);
    return () => (el.removeEventListener("scroll", upd), window.removeEventListener("resize", upd));
  }, [lines !== null]);

  // --------------------------------------------------------------- modifiche
  const commit = useCallback(
    (next: EdLine[], base?: EdLine[]) => {
      setHistory((h) => [...h.slice(-99), base ?? lines!]);
      setLines(next);
    },
    [lines],
  );
  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      setLines(h[h.length - 1]!);
      return h.slice(0, -1);
    });
  }, []);

  const selectLine = useCallback(
    (i: number, listen = true) => {
      setSel({ i, j: null });
      setTapAt({ i, j: 0 });
      if (listen && lines?.[i]?.words[0]) seek(lines[i]!.words[0]!.s - 1.5);
      const el = scrollRef.current;
      const s = lines?.[i]?.words[0]?.s;
      if (el && s !== undefined) el.scrollLeft = Math.max(0, s * zoom - el.clientWidth * 0.3);
    },
    [lines, seek, zoom],
  );

  const startTap = (mode: Tap) => {
    if (!lines) return;
    setTap(mode);
    if (mode === "off") return;
    // si parte dalla prima riga che non è ancora stata cantata
    const i = Math.max(0, lines.findIndex((l) => (l.words[0]?.s ?? 0) >= t - 0.3));
    setTapAt({ i: i >= 0 ? i : 0, j: 0 });
  };

  const doTap = useCallback(() => {
    if (!lines || tap === "off") return;
    const { i, j } = tapAt;
    if (i >= lines.length) return;
    const now = voiceRef.current?.currentTime ?? t;
    if (tap === "lines") {
      commit(tapLine(lines, i, now));
      setSel({ i, j: null });
      setTapAt({ i: i + 1, j: 0 });
      if (i + 1 >= lines.length) setTap("off");
    } else {
      commit(tapWord(lines, i, j, now));
      setSel({ i, j });
      const nj = j + 1 < lines[i]!.words.length ? { i, j: j + 1 } : { i: i + 1, j: 0 };
      setTapAt(nj);
      if (nj.i >= lines.length) setTap("off");
    }
  }, [lines, tap, tapAt, t, commit]);

  const close = useCallback(() => {
    if (dirty && !confirm("Chiudere senza salvare le correzioni?")) return;
    for (const m of media()) m.pause();
    onClose();
  }, [dirty, onClose]);

  const save = async () => {
    if (!lines) return;
    setBusy(true);
    try {
      await api.setTimings(
        song.id,
        lines.map((l) => ({
          manual: !!l.manual,
          words: l.words.map((w) => ({ k: w.k, t: w.t, s: w.s, e: w.e, h: w.h ?? null })),
        })),
      );
      onToast("Tempi del testo salvati");
      for (const m of media()) m.pause();
      onClose();
    } catch (e: any) {
      onToast(e.message);
      setBusy(false);
    }
  };

  // tastiera: spazio play/pausa, INVIO segna l'attacco, ← → per spostarsi, Ctrl+Z annulla
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " ") {
        e.preventDefault();
        toggle();
      } else if (e.key === "Enter") {
        e.preventDefault();
        doTap();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        if (e.shiftKey && lines) commit(shiftLine(lines, sel.i, dir * 0.1));
        else seek((voiceRef.current?.currentTime ?? t) + dir * 2);
      } else if (e.key === "Escape") {
        if (menu) setMenu(null);
        else close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, doTap, undo, seek, t, lines, sel, commit, close, menu]);

  // --------------------------------------------------------------- menu del tasto destro: «Elimina»
  const openMenu = useCallback((e: RMouseEvent, i: number, j: number | null) => {
    e.preventDefault();
    e.stopPropagation();
    setSel({ i, j });
    setMenu({ x: e.clientX, y: e.clientY, i, j });
  }, []);
  const remove = () => {
    if (!lines || !menu) return;
    const { i, j } = menu;
    setMenu(null);
    const next = j === null ? deleteLine(lines, i) : deleteWord(lines, i, j);
    if (!next.length) {
      onToast("Il testo non può restare vuoto");
      return;
    }
    commit(next);
    setSel({ i: Math.min(i, next.length - 1), j: null });
    // la prossima riga da segnare al volo resta la stessa riga di testo
    setTapAt((p) => {
      const gone = next.length < lines.length; // sparita una riga intera
      const ni = gone && p.i > i ? p.i - 1 : p.i;
      return { i: Math.max(0, Math.min(ni, next.length - 1)), j: p.i === i ? 0 : p.j };
    });
  };

  // --------------------------------------------------------------- trascinamento sulla linea del tempo
  const onDown = (e: RPointerEvent, kind: Drag["kind"], i: number, j: number) => {
    if (!lines) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind, i, j, x0: e.clientX, base: lines, moved: false };
    setSel({ i, j: kind === "line" ? null : j });
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const delta = (e.clientX - d.x0) / zoom;
    if (Math.abs(e.clientX - d.x0) < 3 && !d.moved) return;
    d.moved = true;
    const w = d.base[d.i]?.words[d.j];
    if (d.kind === "line") setLines(shiftLine(d.base, d.i, delta));
    else if (d.kind === "word") setLines(moveWord(d.base, d.i, d.j, delta));
    else if (w && d.kind === "start") setLines(setWord(d.base, d.i, d.j, w.s + delta));
    else if (w && d.kind === "end") setLines(setWord(d.base, d.i, d.j, undefined, w.e + delta));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) setHistory((h) => [...h.slice(-99), d.base]);
    else if (d && lines) {
      // clic senza trascinare: si ascolta da poco prima della parola (o della riga)
      const w = lines[d.i]?.words[d.kind === "line" ? 0 : d.j];
      if (w) seek(w.s - 0.6);
    }
  };

  const onTimelineClick = (e: RMouseEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    const x = e.clientX - el.getBoundingClientRect().left + el.scrollLeft;
    seek(x / zoom);
  };
  const onWheel = (e: RWheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom((z) => Math.min(500, Math.max(40, Math.round(z * (e.deltaY < 0 ? 1.2 : 1 / 1.2)))));
  };
  // lo zoom tiene fermo il punto di ascolto
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, t * zoom - el.clientWidth * 0.3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  if (!lines) {
    return (
      <div className="timing-editor">
        <div className="te-loading">
          <Loader2 size={20} className="spin" /> Carico il testo…
        </div>
      </div>
    );
  }

  const total = Math.max(duration, lines.at(-1)?.end ?? 0) + 2;
  const width = total * zoom;
  const t0 = view.left / zoom - 1;
  const t1 = (view.left + view.width) / zoom + 1;
  const next = tap !== "off" ? lines[tapAt.i] : undefined;
  const manualCount = lines.filter((l) => l.manual).length;

  return (
    <div className="timing-editor">
      <audio ref={voiceRef} src={song.media?.vocals} preload="auto" />
      <audio ref={songRef} src={song.media?.instrumental} preload="auto" />

      <header className="te-head">
        <div className="te-title">
          <h3>Correggi i tempi</h3>
          <span className="muted">
            {song.title} · {song.artist}
            {manualCount > 0 && ` · ${manualCount} ${manualCount === 1 ? "riga corretta" : "righe corrette"} a mano`}
          </span>
        </div>
        <div className="te-actions">
          <button className="btn btn-ghost" disabled={!history.length} onClick={undo} title="Annulla (Ctrl+Z)">
            <Undo2 size={16} /> Annulla
          </button>
          <button className="btn btn-ghost" onClick={close}>
            Chiudi
          </button>
          <button className="btn btn-primary" disabled={busy || !dirty} onClick={save}>
            {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />} Salva
          </button>
        </div>
      </header>

      <div className="te-main">
        <div className="te-stage">
          <div className="te-screen">
            <video ref={videoRef} src={song.media?.video} muted preload="auto" playsInline />
            <Preview lines={lines} t={t} />
          </div>

          <div className="te-transport">
            <button className="te-play" onClick={toggle} title="Riproduci / pausa (spazio)">
              {playing ? <Pause size={22} /> : <Play size={22} />}
            </button>
            <span className="te-time">
              {fmt(t)} <span className="muted">/ {fmt(duration)}</span>
            </span>
            <div className="te-seg" role="group" aria-label="Cosa ascoltare">
              <button className={source === "voice" ? "on" : ""} onClick={() => setSource("voice")} title="Solo la voce: gli attacchi si sentono meglio">
                <Mic size={15} /> Voce
              </button>
              <button className={source === "song" ? "on" : ""} onClick={() => setSource("song")} title="Voce e base">
                <Music size={15} /> Brano
              </button>
            </div>
            <div className="te-seg" role="group" aria-label="Velocità">
              {RATES.map((r) => (
                <button key={r} className={rate === r ? "on" : ""} onClick={() => setRate(r)}>
                  {r === 1 ? "1×" : `${r}×`}
                </button>
              ))}
            </div>
          </div>

          <div className={`te-tap ${tap !== "off" ? "on" : ""}`}>
            <div className="te-seg" role="group" aria-label="Correzione al volo">
              <button className={tap === "off" ? "on" : ""} onClick={() => startTap("off")}>
                Trascina
              </button>
              <button className={tap === "lines" ? "on" : ""} onClick={() => startTap("lines")}>
                <Hand size={15} /> Al volo: righe
              </button>
              <button className={tap === "words" ? "on" : ""} onClick={() => startTap("words")}>
                <Hand size={15} /> Al volo: parole
              </button>
            </div>
            {tap === "off" ? (
              <p className="muted">
                Trascina i bordi di una parola per cambiarne inizio e fine, la parola per spostarla, la barra viola
                per spostare la riga intera. Clic sulla linea del tempo per ascoltare da lì.
              </p>
            ) : next ? (
              <div className="te-next">
                <span className="muted">Premi INVIO quando attacca:</span>{" "}
                <b>
                  {tap === "lines"
                    ? next.text
                    : next.words.map((w, k) => (
                        <span key={k} className={k === tapAt.j ? "te-next-word" : ""}>
                          {w.t}{" "}
                        </span>
                      ))}
                </b>
                <button className="btn btn-primary te-now" onClick={doTap}>
                  Adesso
                </button>
              </div>
            ) : (
              <p className="muted">Fine del testo.</p>
            )}
          </div>
        </div>

        <LineList
          lines={lines}
          sel={sel.i}
          onSelect={selectLine}
          onShift={(d) => commit(shiftLine(lines, sel.i, d))}
          onShiftFrom={(d) => commit(shiftFrom(lines, sel.i, d))}
          onRestore={() => commit(restoreLine(lines, original, sel.i))}
          onMenu={openMenu}
        />
      </div>

      <div className="te-timeline">
        <div className="te-zoom">
          <button className="icon-btn" title="Riduci (Ctrl + rotellina)" onClick={() => setZoom((z) => Math.max(40, Math.round(z / 1.25)))}>
            <ZoomOut size={16} />
          </button>
          <button className="icon-btn" title="Ingrandisci (Ctrl + rotellina)" onClick={() => setZoom((z) => Math.min(500, Math.round(z * 1.25)))}>
            <ZoomIn size={16} />
          </button>
        </div>
        <div className="te-scroll" ref={scrollRef} onWheel={onWheel} onPointerMove={onMove} onPointerUp={onUp}>
          <div className="te-canvas" style={{ width }} onClick={onTimelineClick}>
            <Ruler t0={Math.max(0, t0)} t1={t1} zoom={zoom} />
            <Wave env={env} zoom={zoom} total={total} />
            <Lanes lines={lines} zoom={zoom} t0={t0} t1={t1} sel={sel} onDown={onDown} onMenu={openMenu} />
            <div className="te-playhead" style={{ transform: `translateX(${t * zoom}px)` }} />
          </div>
        </div>
      </div>

      {menu && (
        <div
          className="te-menu-back"
          onPointerDown={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(null);
          }}
        >
          <div
            className="te-menu"
            style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 60) }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button onClick={remove}>
              <Trash2 size={15} /> Elimina
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Colorazione come sullo schermo: la riga in corso e la successiva. */
function Preview({ lines, t }: { lines: EdLine[]; t: number }) {
  const times = useMemo(() => switchTimes(lines), [lines]);
  const i = activeIndex(times, t);
  const cur = i >= 0 ? lines[i] : undefined;
  const nxt = lines[i + 1];
  return (
    <div className="te-preview">
      {cur ? (
        <div className="te-pline current">
          {cur.words.map((w, k) => (
            <span key={k} className="lyric-word" style={{ ["--p" as string]: `${(wordFill(w, t) * 100).toFixed(1)}%` }}>
              {w.t}
            </span>
          ))}
        </div>
      ) : (
        <div className="te-pline current muted">…</div>
      )}
      {nxt && <div className="te-pline next">{nxt.text}</div>}
    </div>
  );
}

const LineList = memo(function LineList({
  lines,
  sel,
  onSelect,
  onShift,
  onShiftFrom,
  onRestore,
  onMenu,
}: {
  lines: EdLine[];
  sel: number;
  onSelect: (i: number) => void;
  onShift: (d: number) => void;
  onShiftFrom: (d: number) => void;
  onRestore: () => void;
  onMenu: (e: RMouseEvent, i: number, j: number | null) => void;
}) {
  const selRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // con le graffe: nei Chrome recenti scrollIntoView restituisce una Promise, non una pulizia
    selRef.current?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  return (
    <aside className="te-lines">
      <div className="te-line-tools">
        <span className="muted">Riga selezionata</span>
        <div className="te-row">
          <button className="btn btn-ghost" onClick={() => onShift(-0.1)} title="Riga 0,1 s prima (Maiusc + ←)">
            −0,1 s
          </button>
          <button className="btn btn-ghost" onClick={() => onShift(0.1)} title="Riga 0,1 s dopo (Maiusc + →)">
            +0,1 s
          </button>
          <button className="btn btn-ghost" onClick={onRestore} title="Rimetti la riga com'era all'apertura">
            <RotateCcw size={14} />
          </button>
        </div>
        <span className="muted">Da questa riga alla fine</span>
        <div className="te-row">
          <button className="btn btn-ghost" onClick={() => onShiftFrom(-0.5)}>
            −0,5 s
          </button>
          <button className="btn btn-ghost" onClick={() => onShiftFrom(-0.1)}>
            −0,1 s
          </button>
          <button className="btn btn-ghost" onClick={() => onShiftFrom(0.1)}>
            +0,1 s
          </button>
          <button className="btn btn-ghost" onClick={() => onShiftFrom(0.5)}>
            +0,5 s
          </button>
        </div>
      </div>
      <div className="te-list">
        {lines.map((l, i) => (
          <button
            key={l.id ?? i}
            ref={i === sel ? selRef : undefined}
            className={`te-item ${i === sel ? "sel" : ""}`}
            onClick={() => onSelect(i)}
            onContextMenu={(e) => onMenu(e, i, null)}
          >
            <span className="te-item-time">{fmt(l.words[0]?.s ?? l.start)}</span>
            <span className="te-item-text">{l.text}</span>
            {l.manual && <span className="te-badge" title="Corretta a mano: le correzioni automatiche non la toccano">a mano</span>}
          </button>
        ))}
      </div>
    </aside>
  );
});

const Ruler = memo(function Ruler({ t0, t1, zoom }: { t0: number; t1: number; zoom: number }) {
  const step = zoom >= 60 ? 1 : 2;
  const ticks: number[] = [];
  for (let s = Math.floor(t0 / step) * step; s <= t1; s += step) ticks.push(s);
  return (
    <div className="te-ruler">
      {ticks.map((s) => (
        <div key={s} className={`te-tick ${s % 5 === 0 ? "major" : ""}`} style={{ left: s * zoom }}>
          {s % 5 === 0 && <span>{fmt(s).replace(/\.0$/, "")}</span>}
        </div>
      ))}
    </div>
  );
});

const Wave = memo(function Wave({ env, zoom, total }: { env: { hop: number; env: number[] } | null; zoom: number; total: number }) {
  const path = useMemo(() => {
    if (!env?.env.length) return "";
    const n = env.env.length;
    let d = `M0 100`;
    for (let k = 0; k < n; k++) d += `L${k} ${100 - env.env[k]!}`;
    return d + `L${n} 100Z`;
  }, [env]);
  if (!env) return <div className="te-wave te-wave-loading">Carico la voce…</div>;
  const w = env.env.length * env.hop * zoom;
  return (
    <svg className="te-wave" width={Math.min(w, total * zoom)} height={WAVE} viewBox={`0 0 ${env.env.length} 100`} preserveAspectRatio="none">
      <path d={path} />
    </svg>
  );
});

const Lanes = memo(function Lanes({
  lines,
  zoom,
  t0,
  t1,
  sel,
  onDown,
  onMenu,
}: {
  lines: EdLine[];
  zoom: number;
  t0: number;
  t1: number;
  sel: Sel;
  onDown: (e: RPointerEvent, kind: Drag["kind"], i: number, j: number) => void;
  onMenu: (e: RMouseEvent, i: number, j: number | null) => void;
}) {
  const out: ReactElement[] = [];
  lines.forEach((l, i) => {
    if (!l.words.length) return;
    const s = l.words[0]!.s;
    const e = l.words[l.words.length - 1]!.e;
    if (e < t0 || s > t1) return;
    const cls = `${i % 2 ? "odd" : "even"} ${l.manual ? "manual" : ""} ${sel.i === i ? "sel" : ""}`;
    out.push(
      <div
        key={`l${i}`}
        className={`te-lbar ${cls}`}
        style={{ left: s * zoom, width: Math.max(4, (e - s) * zoom) }}
        onPointerDown={(ev) => ev.button === 0 && onDown(ev, "line", i, 0)}
        onClick={(ev) => ev.stopPropagation()}
        onContextMenu={(ev) => onMenu(ev, i, null)}
        title={`Riga ${i + 1}: trascina per spostarla tutta`}
      >
        <span>{i + 1}</span>
      </div>,
    );
    l.words.forEach((w, j) => {
      if (w.e < t0 || w.s > t1) return;
      const on = sel.i === i && sel.j === j;
      out.push(
        <div
          key={`w${i}.${j}`}
          className={`te-word ${cls} ${on ? "on" : ""}`}
          style={{ left: w.s * zoom, width: Math.max(3, (w.e - w.s) * zoom) }}
          onPointerDown={(ev) => ev.button === 0 && onDown(ev, "word", i, j)}
          onClick={(ev) => ev.stopPropagation()}
          onContextMenu={(ev) => onMenu(ev, i, j)}
        >
          <div className="te-handle l" onPointerDown={(ev) => ev.button === 0 && onDown(ev, "start", i, j)} title="Inizio della parola" />
          <span>{w.t}</span>
          <div className="te-handle r" onPointerDown={(ev) => ev.button === 0 && onDown(ev, "end", i, j)} title="Fine della parola" />
        </div>,
      );
    });
  });
  return (
    <div className="te-lanes" style={{ height: LANE_LINE + LANE_WORD }}>
      {out}
    </div>
  );
});
