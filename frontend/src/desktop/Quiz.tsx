import { CSSProperties, useEffect, useRef } from "react";
import { CalendarDays, Mic2, Music, Quote, Smartphone } from "lucide-react";
import { Avatar } from "../shared/Avatar";
import { useTick } from "../shared/queue";
import { OPTION_LETTERS, QUIZ_TITLE, quizLeft, QuizState, useQuiz } from "../shared/quiz";
import { Confetti } from "./Competition";
import { beep } from "./resultSounds";

/** Ultimi secondi dell'introduzione (e del tempo per rispondere): numeroni, pulsazioni e bip. */
const COUNTDOWN = 5;

/** Categoria della domanda (si annuncia già nell'introduzione). */
const KINDS: Record<QuizState["kind"], { label: string; Icon: typeof Music }> = {
  title: { label: "Titolo del brano", Icon: Music },
  artist: { label: "Chi canta", Icon: Mic2 },
  year: { label: "Anno di uscita", Icon: CalendarDays },
  next_word: { label: "Parola successiva", Icon: Quote },
};

function Kind({ q }: { q: QuizState }) {
  const k = KINDS[q.kind] ?? KINDS.title;
  return (
    <span className="quiz-kind">
      <k.Icon /> {k.label}
    </span>
  );
}

/**
 * Quiz musicale sulla TV, fra un brano e l'altro: annuncio (tutti al telefono) e conto alla rovescia
 * a numeroni, pezzo del brano (solo audio) con le tre risposte, chi ha risposto cosa e chi ha
 * indovinato, classifica.
 */
export function QuizOverlay() {
  const q = useQuiz();
  useTick(200);
  useClip(q);
  useCountdownSounds(q);
  if (!q) return null;
  return (
    <div className={`quiz phase-${q.phase}`}>
      <div className="quiz-glow" aria-hidden>
        <i />
        <i />
        <i />
      </div>
      {q.phase === "intro" && <Intro q={q} />}
      {(q.phase === "question" || q.phase === "reveal") && <Question q={q} />}
      {q.phase === "ranking" && <Ranking q={q} />}
    </div>
  );
}

/** Il pezzo del brano: si carica durante la scritta, suona durante la domanda, si ferma alla risposta. */
function useClip(q: QuizState | null) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const id = q?.id;
  const phase = q?.phase;
  const clip = useRef(q?.clip);
  clip.current = q?.clip;
  // nuovo quiz: si prepara l'audio
  useEffect(() => {
    if (!id) return;
    const a = new Audio(`/api/quiz/clip?q=${encodeURIComponent(id)}`);
    a.preload = "auto";
    const vol = parseFloat(localStorage.getItem("sin.volume") ?? "");
    a.volume = isFinite(vol) ? Math.max(0, Math.min(1, vol)) : 1;
    const seek = () => {
      if (clip.current) a.currentTime = clip.current.start;
    };
    a.addEventListener("loadedmetadata", seek, { once: true });
    // fine del pezzo: sfuma e si ferma (per la parola successiva si ferma proprio prima della parola)
    const onTime = () => {
      const c = clip.current;
      if (c && a.currentTime >= c.end) a.pause();
    };
    a.addEventListener("timeupdate", onTime);
    audio.current = a;
    return () => {
      a.pause();
      a.removeEventListener("timeupdate", onTime);
      a.src = "";
      audio.current = null;
    };
  }, [id]);
  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    if (phase === "question") {
      if (clip.current && Math.abs(a.currentTime - clip.current.start) > 0.5) a.currentTime = clip.current.start;
      a.play().catch(() => {});
      // per la parola successiva serve un fermo preciso: timeupdate arriva ogni ~250 ms
      const c = clip.current;
      if (!c) return;
      const t = window.setInterval(() => {
        if (a.currentTime >= c.end - 0.03) a.pause();
      }, 20);
      return () => window.clearInterval(t);
    }
    a.pause();
  }, [phase]);
}

/**
 * Bip del conto alla rovescia: da 5 a 1 alla fine dell'introduzione (l'1 più acuto), il «via» quando
 * parte la domanda, e un bip leggero negli ultimi 5 secondi per rispondere.
 */
function useCountdownSounds(q: QuizState | null) {
  const last = useRef("");
  const key = q ? `${q.id}:${q.phase}:${quizLeft(q)}` : "";
  useEffect(() => {
    if (!q || key === last.current) return;
    const prevPhase = last.current.split(":")[1];
    last.current = key;
    const left = quizLeft(q);
    if (q.phase === "intro" && left >= 1 && left <= COUNTDOWN) beep(left === 1 ? 784 : 523, left === 1);
    else if (q.phase === "question" && prevPhase === "intro") beep(1047, true, 0.11);
    else if (q.phase === "question" && left >= 1 && left <= COUNTDOWN) beep(440, false, 0.05);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Annuncio del quiz: prima «Prendete il telefono!» con la categoria della domanda, poi negli ultimi
 * 5 secondi numeroni al centro che entrano con un colpo, pulsano e si scaldano fino all'1.
 */
function Intro({ q }: { q: QuizState }) {
  const left = quizLeft(q);
  const counting = left <= COUNTDOWN;
  const heat = counting ? Math.min(1, (COUNTDOWN - left) / (COUNTDOWN - 1)) : 0; // 0 al 5, 1 all'1
  return (
    <div className={`quiz-intro ${counting ? "counting" : ""}`} style={{ "--heat": heat } as CSSProperties}>
      <div className="quiz-rays" aria-hidden />
      <h1 className="quiz-title" aria-label={QUIZ_TITLE}>
        {QUIZ_TITLE.split("").map((ch, i) => (
          <span key={i} style={{ animationDelay: `${i * 0.06}s` }}>
            {ch === " " ? " " : ch}
          </span>
        ))}
      </h1>
      {!counting ? (
        <div className="quiz-call">
          <div className="quiz-phone" aria-hidden>
            <span className="quiz-phone-wave" />
            <span className="quiz-phone-wave" style={{ animationDelay: "0.7s" }} />
            <Smartphone />
          </div>
          <div className="quiz-call-text">
            <b>Prendete il telefono!</b>
            <span>Sta per arrivare una domanda: tre risposte, vince chi indovina per primo</span>
          </div>
          <Kind q={q} />
        </div>
      ) : (
        <div className="quiz-countdown">
          {/* a ogni secondo il numero entra con un colpo, due onde si allargano e poi pulsa */}
          <div className="quiz-beat" key={left}>
            <span className="quiz-shock" />
            <span className="quiz-shock late" />
            <span className="quiz-big">{left || "VIA!"}</span>
          </div>
          <div className="quiz-ready">
            <Kind q={q} />
            <span>Pronti a rispondere dal telefono</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Tempo per rispondere: anello che si svuota con i secondi al centro (rosso e pulsante alla fine). */
function Clock({ left, total }: { left: number; total: number }) {
  const r = 44;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, left / total));
  return (
    <div className={`quiz-clock ${left <= COUNTDOWN ? "hurry" : ""}`}>
      <svg viewBox="0 0 100 100" aria-hidden>
        <defs>
          <linearGradient id="quiz-clock-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff3d9a" />
            <stop offset="0.55" stopColor="#8b5cf6" />
            <stop offset="1" stopColor="#22d3ee" />
          </linearGradient>
        </defs>
        <circle className="quiz-clock-track" cx="50" cy="50" r={r} />
        <circle className="quiz-clock-fill" cx="50" cy="50" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - frac)} />
      </svg>
      <b key={left}>{left}</b>
    </div>
  );
}

function Question({ q }: { q: QuizState }) {
  const reveal = q.phase === "reveal";
  const left = quizLeft(q);
  const total = q.kind === "next_word" ? 22 : 20;
  const byChoice = (i: number) => (q.answers ?? []).filter((a) => a.choice === i);
  return (
    <div className="quiz-question">
      {reveal && q.winner && <Confetti count={110} />}
      {!reveal && <Clock left={left} total={total} />}
      <div className="quiz-head">
        <div className="quiz-chips">
          <span className="quiz-badge">{QUIZ_TITLE}</span>
          <Kind q={q} />
        </div>
        <h2>{q.question}</h2>
        {!reveal && (
          <div className="quiz-listen">
            <span className="quiz-eq" aria-hidden>
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
            Ascoltate e rispondete dal telefono
          </div>
        )}
      </div>
      <div className="quiz-options">
        {q.options.map((o, i) => (
          <div
            key={i}
            className={`quiz-option opt-${i} ${reveal ? (i === q.correct ? "right" : "wrong") : ""}`}
            style={{ animationDelay: `${i * 0.12}s` }}
          >
            <span className="quiz-letter">{OPTION_LETTERS[i]}</span>
            <span className="quiz-text">{o}</span>
            {reveal && (
              <div className="quiz-voters">
                {byChoice(i).map((a) => (
                  <span key={a.name} className={`quiz-voter ${a.name === q.winner ? "winner" : ""}`} title={a.name}>
                    <Avatar name={a.name} />
                    <small>{a.name}</small>
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {!reveal && q.answered.length > 0 && (
        <div className="quiz-answered">
          {q.answered.map((n) => (
            <Avatar key={n} name={n} />
          ))}
          <span>
            {q.answered.length === 1 ? "1 risposta" : `${q.answered.length} risposte`}, nessuna ancora giusta
          </span>
        </div>
      )}
      {reveal && (
        <div className="quiz-result">
          {q.winner ? (
            <div className="quiz-winner">
              <Avatar name={q.winner} className="quiz-winner-avatar" />
              <div>
                <div className="quiz-winner-name">{q.winner} ha indovinato!</div>
                <div className="quiz-winner-points">{q.points ? `+${q.points} punti in classifica` : "ha già il massimo dei punti del quiz"}</div>
              </div>
            </div>
          ) : (
            <div className="quiz-nobody">Nessuno ha indovinato!</div>
          )}
          {q.song && (
            <div className="quiz-song">
              {q.song.thumbnail_url && <img src={q.song.thumbnail_url} alt="" />}
              <span>
                «{q.song.title}» {q.song.artist && <>di {q.song.artist}</>} {q.song.year && <>({q.song.year})</>}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Ranking({ q }: { q: QuizState }) {
  const r = q.ranking;
  const rows = r?.rows ?? [];
  return (
    <div className="quiz-ranking">
      <span className="quiz-badge">{QUIZ_TITLE}</span>
      <h2>{r?.kind === "competition" ? "Classifica della Competizione" : "Classifica del quiz"}</h2>
      {rows.length === 0 ? (
        <p className="quiz-hint">La classifica comincia con il primo brano votato</p>
      ) : (
        <ol>
          {rows.map((row, i) => (
            <li key={row.name} className={row.name === q.winner ? "winner" : ""} style={{ animationDelay: `${i * 0.08}s` }}>
              <span className="quiz-pos">{i + 1}</span>
              <Avatar name={row.name} />
              <span className="quiz-rname">{row.name}</span>
              {r?.kind === "competition" && !!row.quiz && <span className="quiz-bonus">+{row.quiz} quiz</span>}
              <b>{r?.kind === "competition" ? row.value.toFixed(1) : `${row.value} ${row.value === 1 ? "risposta" : "risposte"}`}</b>
            </li>
          ))}
        </ol>
      )}
      <p className="quiz-hint">Fra {quizLeft(q)} secondi si riparte con la musica</p>
    </div>
  );
}
