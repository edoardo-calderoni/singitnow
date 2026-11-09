import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Crown, Music, Trophy } from "lucide-react";
import { Avatar } from "../shared/Avatar";
import type { HallEntry, ScoreSaved, Standing } from "../shared/api";
import { fmtAverage } from "../shared/competition";
import { Confetti } from "./Competition";
import { Grade, gradeOf, Results, Stat } from "./performance";
import { crowd, drumroll, preloadCrowd, tick } from "./resultSounds";

export interface ResultItem {
  name: string; // chi ha cantato ("" = senza nome)
  label: string; // con due microfoni: quale microfono
  results: Results;
  /** voto salvato sul PC: porta la posizione in classifica e la classifica da mostrare dopo */
  saved: Promise<ScoreSaved | null>;
}

const START = 0.7; // s: prima barra
const STEP = 0.585; // s: fra una barra e l'altra
const GROW = 0.78; // s: crescita di una barra piena
const ROLL = 1.6; // s: rullo di tamburi prima del voto
export const AFTER_SOUND = 4; // s: dalla fine della reazione del pubblico alla schermata dopo
const BOARD_SECONDS = 12; // s: classifica della sessione e Hall of Fame dopo il voto
const WINNER_AFTER = 3; // s: schermata del vincitore, dopo la fine dell'applauso
const FADE_OUT = 1.2; // s: dissolvenza del pannello verso la schermata sotto

export interface ResultsRequest {
  items: ResultItem[];
  title: string;
  artist: string;
  /** ultimo brano della serata (coda finita e niente in preparazione): alla fine si festeggia il vincitore */
  isLast: () => boolean;
  /** tempo scaduto: parte il brano dopo o si torna alla schermata principale, sotto il pannello */
  onLeave: () => void;
}

// vincitore appena festeggiato nel pannello: la schermata del vincitore che il PC manda a sessione
// chiusa (qualche secondo dopo) non si mostra una seconda volta
let winnerCelebratedAt = 0;
export const winnerJustCelebrated = () => Date.now() - winnerCelebratedAt < 60_000;

// Il pannello vive fuori dal player (in App): così, quando il player si chiude o passa al brano
// dopo, il pannello resta sopra e sfuma sulla schermata nuova invece di sparire di colpo.
let current: (ResultsRequest & { id: number }) | null = null;
let seq = 0;
const listeners = new Set<() => void>();
export function showResults(r: ResultsRequest | null) {
  current = r ? { ...r, id: ++seq } : null;
  listeners.forEach((l) => l());
}

/** Pannello dei punteggi a schermo in questo momento. */
export function useResultsOpen(): boolean {
  const [open, setOpen] = useState(!!current);
  useEffect(() => {
    const l = () => setOpen(!!current);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return open;
}

export function ResultsHost() {
  const [r, setR] = useState(current);
  useEffect(() => {
    const l = () => setR(current);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  if (!r) return null;
  return (
    <ResultsPanel
      key={r.id}
      {...r}
      onGone={() => {
        if (current?.id === r.id) showResults(null);
      }}
    />
  );
}

/** Classifica mostrata dopo il voto: della competizione (se accesa) o hall of fame del brano. */
interface Board {
  competition: boolean;
  standings: Standing[];
  hall: HallEntry[];
  /** chi ha appena cantato (nomi) e i suoi voti appena salvati (istanti), da evidenziare */
  names: Set<string>;
  /** nessuno ha messo il nome: il voto non entra in classifica */
  anonymous: boolean;
  times: Set<number>;
}

/**
 * Pannello di fine brano: le statistiche crescono una alla volta (con un battito), poi rullo di
 * tamburi e voto da A a F con la reazione del pubblico. Finita la reazione, dopo AFTER_SOUND
 * secondi il pannello passa alla classifica della competizione (se accesa) o alla hall of fame del
 * brano; BOARD_SECONDS dopo chiama onLeave (sotto parte il brano dopo o torna la schermata
 * principale) e sfuma. Un clic salta avanti di una fase.
 */
function ResultsPanel({ items, title, artist, isLast, onLeave, onGone }: ResultsRequest & { onGone: () => void }) {
  const stats = items[0].results.stats.length;
  const [started, setStarted] = useState(0); // barre partite
  const [revealed, setRevealed] = useState(false);
  const [phase, setPhase] = useState<"results" | "board" | "winner">("results");
  const isLastRef = useRef(isLast);
  isLastRef.current = isLast;
  const [leaving, setLeaving] = useState(false);
  const [saved, setSaved] = useState<(ScoreSaved | null)[]>([]);
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  const stopCrowd = useRef<() => void>(() => {});
  const alive = useRef(true);
  const gone = useRef(false);
  const timers = useRef<number[]>([]);
  // con due microfoni il pubblico reagisce al voto medio
  const grade: Grade = gradeOf(items.reduce((a, it) => a + it.results.score, 0) / items.length);

  // classifica da mostrare dopo il voto (dalla risposta del PC al salvataggio)
  const first = saved.find(Boolean) ?? null;
  const board: Board | null = first
    ? {
        competition: first.competition,
        standings: first.standings,
        hall: first.hall_of_fame,
        names: new Set(items.map((it) => it.name.toLocaleLowerCase()).filter(Boolean)),
        anonymous: items.every((it) => !it.name),
        times: new Set(saved.filter((r): r is ScoreSaved => !!r).map((r) => r.t)),
      }
    : null;
  // la classifica si mostra solo se chi ha cantato ha un nome (senza nome il voto non entra in classifica)
  const hasBoard = !!board && !board.anonymous;
  const hasBoardRef = useRef(false);
  hasBoardRef.current = hasBoard;
  const winner = board?.standings[0] ?? null;
  const winnerRef = useRef(winner);
  winnerRef.current = winner;

  const clear = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  };
  const at = (s: number, fn: () => void) => timers.current.push(window.setTimeout(fn, s * 1000));

  const leave = () => {
    if (gone.current) return;
    gone.current = true;
    clear();
    setLeaving(true);
    stopCrowd.current(); // sfuma piano: continua anche sulla schermata nuova
    leaveRef.current();
    at(FADE_OUT, () => goneRef.current());
  };

  // fine della serata: vincitore della sessione con coriandoli e l'applauso più forte (voto A)
  const showWinner = () => {
    if (gone.current) return;
    clear();
    if (!isLastRef.current() || !winnerRef.current) return leave();
    setPhase("winner");
    winnerCelebratedAt = Date.now();
    crowd("A").then(({ seconds, stop }) => {
      if (!alive.current || gone.current) return stop();
      stopCrowd.current = stop;
      at(Math.max(seconds, 4) + WINNER_AFTER, leave);
    });
  };

  const showBoard = () => {
    if (gone.current) return;
    clear();
    if (!hasBoardRef.current) return showWinner();
    setPhase("board");
    at(BOARD_SECONDS, showWinner);
  };

  const reveal = () => {
    clear();
    setStarted(stats);
    setRevealed(true);
    // il pubblico reagisce una volta; finito l'effetto, ancora AFTER_SOUND secondi e si passa oltre
    crowd(grade).then(({ seconds, stop }) => {
      if (!alive.current || gone.current) {
        stop(); // il pannello è già chiuso
        return;
      }
      stopCrowd.current = stop;
      at(seconds + AFTER_SOUND, showBoard);
    });
  };

  useEffect(() => {
    preloadCrowd(grade);
    Promise.all(items.map((it) => it.saved)).then((r) => {
      if (alive.current) setSaved(r);
    });
    for (let i = 0; i < stats; i++) at(START + i * STEP, () => setStarted(i + 1));
    const rollAt = START + (stats - 1) * STEP + GROW + 0.3;
    at(rollAt, () => drumroll(ROLL));
    at(rollAt + ROLL, reveal);
    return () => {
      alive.current = false;
      clear();
      stopCrowd.current(); // il pubblico sfuma quando parte il brano dopo
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onClick = () => {
    if (!revealed) reveal();
    else if (phase === "results") showBoard();
    else if (phase === "board") showWinner();
    else leave();
  };

  return createPortal(
    <div className={`results-back ${leaving ? "leaving" : ""}`} onClick={onClick}>
      {phase === "results" ? (
        <div className={`results ${items.length > 1 ? "duo" : ""}`} key="results">
          <div className="results-title">
            <Music size={30} />
            <span className="ellipsis">
              <b>{title}</b>
              {artist && <span className="results-artist"> · {artist}</span>}
            </span>
          </div>
          <div className="results-row">
            {items.map((it, k) => {
              const pos = saved[k]?.competition_position;
              return (
                <div className="results-card" key={k}>
                  <div className="results-head">
                    {it.name && <Avatar name={it.name} className={items.length > 1 ? "" : "big"} />}
                    <div className="results-who ellipsis">{it.name || it.label || "Risultato"}</div>
                  </div>
                  <div className="results-body">
                    <div className="results-stats">
                      {it.results.stats.map((s, i) => (
                        <StatBar key={s.key} stat={s} active={i < started} sound={k === 0} instant={revealed} />
                      ))}
                    </div>
                    <div className={`results-grade g-${it.results.grade.toLowerCase()} ${revealed ? "shown" : ""}`}>
                      {revealed ? (
                        <>
                          <div className="grade-rays" />
                          <div className="grade-letter">{it.results.grade}</div>
                          <div className="grade-score">
                            <b>{it.results.score}</b>/100
                          </div>
                          <div className="grade-text">{it.results.phrase}</div>
                          {pos ? (
                            <div className="grade-pos">
                              <Trophy size={22} /> {pos}° posto in classifica
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <div className="grade-wait">?</div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : phase === "board" ? (
        <div className="results board-panel" key="board">
          <BoardView board={board!} title={title} />
        </div>
      ) : (
        <WinnerView winner={winner!} />
      )}
    </div>,
    document.body,
  );
}

const fmtDate = (t: number) =>
  new Date(t * 1000).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });

const SESSION_ROWS = 5; // posti della classifica della sessione mostrati sopra la Hall of Fame

/**
 * Classifica della sessione e, sotto, Hall of Fame del brano (i 7 migliori punteggi di sempre),
 * con foto e nome; chi ha appena cantato è evidenziato.
 */
function BoardView({ board, title }: { board: Board; title: string }) {
  const medal = (i: number) =>
    i < 3 ? <span className={`board-medal m${i + 1}`}>{i + 1}</span> : <span className="board-num">{i + 1}°</span>;
  const session = board.standings.slice(0, SESSION_ROWS);
  return (
    <div className="board board-double">
      <section>
        <div className="board-head">
          <Trophy size={40} />
          <div className="board-titles">
            <div className="board-title">Classifica della sessione</div>
            <div className="board-sub ellipsis">Media dei voti della serata</div>
          </div>
        </div>
        {session.length === 0 && <div className="board-empty">Ancora nessun punteggio in classifica.</div>}
        <ol className="board-list">
          {session.map((p, i) => (
            <li
              key={p.singer}
              className={board.names.has(p.singer.toLocaleLowerCase()) ? "me" : ""}
              style={{ animationDelay: `${i * 0.08}s` }}
            >
              {medal(i)}
              <Avatar name={p.singer} />
              <span className="board-name ellipsis">{p.singer}</span>
              <span className="board-extra">
                {p.songs.length} {p.songs.length === 1 ? "brano" : "brani"}
              </span>
              <b className="board-score">{fmtAverage(p.average)}</b>
            </li>
          ))}
        </ol>
      </section>
      <section>
        <div className="board-head">
          <Crown size={40} />
          <div className="board-titles">
            <div className="board-title">Hall of Fame</div>
            <div className="board-sub ellipsis">I migliori di sempre su «{title}»</div>
          </div>
        </div>
        {board.hall.length === 0 && <div className="board-empty">Ancora nessun punteggio su questo brano.</div>}
        <ol className="board-list">
          {board.hall.map((h, i) => (
            <li
              key={`${h.singer}-${h.t}`}
              className={board.times.has(h.t) ? "me" : ""}
              style={{ animationDelay: `${0.4 + i * 0.08}s` }}
            >
              {medal(i)}
              <Avatar name={h.avatar || h.singer} />
              <span className="board-name ellipsis">{h.singer}</span>
              <span className="board-extra">{fmtDate(h.t)}</span>
              <span className={`board-grade g-${gradeOf(h.score).toLowerCase()}`}>{gradeOf(h.score)}</span>
              <b className="board-score">{h.score}</b>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** Fine della serata: il vincitore della sessione al centro, con i coriandoli che cadono. */
function WinnerView({ winner }: { winner: Standing }) {
  return (
    <div className="winner-final" key="winner">
      <Confetti count={180} />
      <div className="winner-final-card">
        <div className="winner-final-eyebrow">
          <Trophy size={34} /> Vincitore della sessione
        </div>
        <Avatar name={winner.singer} className="winner-final-photo" />
        <h1 className="winner-final-name grad-text">Complimenti {winner.singer}!</h1>
        <div className="winner-final-msg">
          Hai vinto la sfida di stasera con una media di <b>{fmtAverage(winner.average)}</b>/100 su{" "}
          {winner.songs.length} {winner.songs.length === 1 ? "brano" : "brani"}. Sei tu la stella del palco!
        </div>
      </div>
    </div>
  );
}

/** Una statistica: la barra cresce da 0 al valore, il numero conta in su. */
function StatBar({ stat, active, sound, instant }: { stat: Stat; active: boolean; sound: boolean; instant: boolean }) {
  const [p, setP] = useState(0); // 0..1 della crescita
  useEffect(() => {
    if (!active) return;
    if (instant) {
      setP(1);
      return;
    }
    const dur = Math.max(0.15, (GROW * stat.value) / 100) * 1000;
    const t0 = performance.now();
    let raf = 0;
    let lastTick = 0;
    const step = (now: number) => {
      const x = Math.min(1, (now - t0) / dur);
      const e = 1 - (1 - x) ** 3;
      setP(e);
      if (sound && now - lastTick > 95 && x < 1) {
        lastTick = now;
        tick((stat.value / 100) * e); // lunghezza attuale della barra
      }
      if (x < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, instant]);

  // i valori in percentuale contano in su; gli altri compaiono a fine barra
  const pctText = /^\d+%$/.test(stat.text);
  const text = !active ? "" : pctText ? `${Math.round(stat.value * p)}%` : p >= 1 ? stat.text : "";
  return (
    <div className={`stat ${active ? "on" : ""} t-${stat.tone}`}>
      <div className="stat-top">
        <span className="stat-label">{stat.label}</span>
        <b className="stat-val">{text}</b>
      </div>
      <div className="stat-track">
        <div className="stat-fill" style={{ width: `${stat.value * p}%` }} />
      </div>
      {stat.hint && <div className={`stat-hint ${p >= 1 ? "on" : ""}`}>{stat.hint}</div>}
    </div>
  );
}
