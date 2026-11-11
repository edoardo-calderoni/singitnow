import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ListOrdered, MicOff, Trophy, Users, X } from "lucide-react";
import { api, Standing } from "../shared/api";
import { Avatar } from "../shared/Avatar";
import { fmtAverage, useCompetition } from "../shared/competition";
import { useJukebox } from "../shared/mode";
import { cheer } from "./Applause";

/**
 * Interruttore «Competizione» sotto Karaoke/Jukebox, nella barra laterale. A sessione finita
 * compare il pulsante per rivedere la classifica (fino all'inizio della sessione successiva).
 */
export function CompetitionSwitch({ onShowRanking }: { onShowRanking: () => void }) {
  const comp = useCompetition();
  const jukebox = useJukebox();
  // es. «Nessun microfono rilevato…»: avviso in primo piano, l'interruttore resta spento
  const [notice, setNotice] = useState("");
  if (jukebox) return null; // in Jukebox non si canta: niente voti né classifica
  return (
    <div className="comp-box">
      {notice && createPortal(<NoticeDialog message={notice} onClose={() => setNotice("")} />, document.body)}
      <label className="comp-switch">
        <input
          type="checkbox"
          checked={comp.enabled}
          onChange={(e) => api.setCompetition(e.target.checked).catch((err) => setNotice(err.message))}
        />
        <span className="comp-track" aria-hidden>
          <span className="comp-thumb" />
        </span>
        <span className="comp-label">
          <Trophy size={15} /> Competizione
        </span>
      </label>
      {comp.enabled && comp.standings.length > 0 && (
        <button className="btn btn-ghost btn-sm comp-ranking-btn" onClick={onShowRanking}>
          <ListOrdered size={15} /> Classifica
        </button>
      )}
    </div>
  );
}

/** Avviso in primo piano con un solo pulsante «Ok». */
function NoticeDialog({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal notice-modal" role="alertdialog" onClick={(e) => e.stopPropagation()}>
        <div className="notice-icon">{/microfono/i.test(message) ? <MicOff size={26} /> : <Users size={26} />}</div>
        <p>{message}</p>
        <div className="actions">
          <button className="btn btn-primary" autoFocus onClick={onClose}>
            Ok
          </button>
        </div>
      </div>
    </div>
  );
}

/** Righe della classifica: posizione, foto, nome, media e voti dei singoli brani. */
export function StandingsList({ standings, limit, details = true }: { standings: Standing[]; limit?: number; details?: boolean }) {
  const shown = limit ? standings.slice(0, limit) : standings;
  return (
    <ol className="standings">
      {shown.map((s, i) => (
        <li key={s.singer} className={i === 0 ? "first" : ""}>
          <span className="st-pos">{i === 0 ? <Trophy size={16} /> : `${i + 1}°`}</span>
          <Avatar name={s.singer} className="xs" />
          <div className="st-main">
            <div className="st-name ellipsis">{s.singer}</div>
            {details && (
              <div className="st-songs">
                {s.songs.map((song, k) => (
                  <span key={k} className="st-song" title={song.title}>
                    <span className="ellipsis">{song.title}</span> <b>{song.score}</b>
                  </span>
                ))}
              </div>
            )}
          </div>
          <b className="st-avg">{fmtAverage(s.average)}</b>
        </li>
      ))}
    </ol>
  );
}

/** Classifica completa della sessione (pulsante «Classifica» a sessione finita). */
export function RankingDialog({ onClose }: { onClose: () => void }) {
  const comp = useCompetition();
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal modal-ranking" onClick={(e) => e.stopPropagation()}>
        <div className="ranking-head">
          <h3>
            <Trophy size={20} /> Classifica della sessione
          </h3>
          <button className="icon-btn" title="Chiudi" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Media dei voti d'intonazione dei brani cantati da ciascuno.
        </p>
        {comp.standings.length ? (
          <StandingsList standings={comp.standings} />
        ) : (
          <div className="muted">Nessun punteggio in questa sessione.</div>
        )}
      </div>
    </div>
  );
}

/**
 * Classifica in tempo reale nell'angolo in alto a destra (richiesta da un amministratore):
 * piccola, lontana dal testo della canzone, sparisce da sola come i QR code.
 */
export function RankingCorner({ seconds, onClose }: { seconds: number; onClose: () => void }) {
  const comp = useCompetition();
  return (
    <div
      className="wifi-corner ranking-corner"
      title="Clic per chiudere"
      style={{ "--wifi-seconds": `${seconds}s` } as React.CSSProperties}
      onClick={onClose}
    >
      <div className="wifi-corner-head">
        <Trophy size={18} /> Classifica
      </div>
      {comp.standings.length ? (
        <StandingsList standings={comp.standings} limit={6} details={false} />
      ) : (
        <div className="wifi-corner-hint">Ancora nessun punteggio in questa sessione</div>
      )}
    </div>
  );
}

const CONFETTI_COLORS = ["#ec4899", "#8b5cf6", "#22d3ee", "#facc15", "#34d399", "#f97316"];

/** Fine della playlist in competizione: coriandoli, applausi e coppa per il vincitore. */
/** Coriandoli colorati che cadono dall'alto (schermate del vincitore). */
export function Confetti({ count = 140 }: { count?: number }) {
  const confetti = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 4,
        duration: 3.5 + Math.random() * 3,
        size: 6 + Math.random() * 8,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        drift: (Math.random() - 0.5) * 30,
        round: Math.random() < 0.3,
      })),
    [count],
  );
  return (
    <div className="confetti" aria-hidden>
      {confetti.map((c, i) => (
        <span
          key={i}
          style={{
            left: `${c.left}%`,
            width: c.size,
            height: c.round ? c.size : c.size * 0.45,
            borderRadius: c.round ? "50%" : 2,
            background: c.color,
            animationDelay: `${c.delay}s`,
            animationDuration: `${c.duration}s`,
            ["--drift" as string]: `${c.drift}vw`,
          }}
        />
      ))}
    </div>
  );
}

export function WinnerScreen({
  standings,
  onClose,
  autoClose = 0,
}: {
  standings: Standing[];
  onClose: () => void;
  /** secondi dopo i quali si chiude da sola (0: resta finché non si chiude) */
  autoClose?: number;
}) {
  const winner = standings[0];
  const [full, setFull] = useState(false);
  useEffect(() => cheer(), []);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!autoClose) return;
    const t = window.setTimeout(() => closeRef.current(), autoClose * 1000);
    return () => window.clearTimeout(t);
  }, [autoClose]);
  const confetti = useMemo(
    () =>
      Array.from({ length: 140 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 4,
        duration: 3.5 + Math.random() * 3,
        size: 6 + Math.random() * 8,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        drift: (Math.random() - 0.5) * 30,
        round: Math.random() < 0.3,
      })),
    [],
  );
  if (!winner) return null;
  return (
    <div className="winner-screen" onClick={onClose}>
      <div className="confetti" aria-hidden>
        {confetti.map((c, i) => (
          <span
            key={i}
            style={{
              left: `${c.left}%`,
              width: c.size,
              height: c.round ? c.size : c.size * 0.45,
              borderRadius: c.round ? "50%" : 2,
              background: c.color,
              animationDelay: `${c.delay}s`,
              animationDuration: `${c.duration}s`,
              ["--drift" as string]: `${c.drift}vw`,
            }}
          />
        ))}
      </div>
      <div className="winner-card" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn winner-close" title="Chiudi" onClick={onClose}>
          <X size={20} />
        </button>
        <div className="winner-trophy">🏆</div>
        <div className="eyebrow">Vincitore della competizione</div>
        <div className="winner-who">
          <Avatar name={winner.singer} className="winner-photo" />
          <h1 className="grad-text">Complimenti {winner.singer}!</h1>
        </div>
        <div className="winner-score">
          <b className="grad-text">{fmtAverage(winner.average)}</b>
          <span>/100 di media</span>
        </div>
        <ul className="winner-songs">
          {winner.songs.map((s, i) => (
            <li key={i}>
              <span className="ellipsis">{s.title}</span>
              <b>{s.score}</b>
            </li>
          ))}
        </ul>
        {standings.length > 1 &&
          (full ? (
            <StandingsList standings={standings} />
          ) : (
            <button className="btn btn-ghost" onClick={() => setFull(true)}>
              <ListOrdered size={16} /> Classifica completa
            </button>
          ))}
      </div>
    </div>
  );
}
