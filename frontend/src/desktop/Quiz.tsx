import { useEffect, useRef } from "react";
import { Avatar } from "../shared/Avatar";
import { useTick } from "../shared/queue";
import { OPTION_LETTERS, QUIZ_TITLE, quizLeft, QuizState, useQuiz } from "../shared/quiz";
import { Confetti } from "./Competition";

/**
 * Quiz musicale sulla TV, fra un brano e l'altro: scritta con il conto alla rovescia, pezzo del
 * brano (solo audio) con le tre risposte, chi ha risposto cosa e chi ha indovinato, classifica.
 */
export function QuizOverlay() {
  const q = useQuiz();
  useTick(200);
  useClip(q);
  if (!q) return null;
  return (
    <div className={`quiz quiz-${q.phase}`}>
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

function Intro({ q }: { q: QuizState }) {
  const left = quizLeft(q);
  return (
    <div className="quiz-intro">
      <div className="quiz-rays" aria-hidden />
      <h1 className="quiz-title" aria-label={QUIZ_TITLE}>
        {QUIZ_TITLE.split("").map((ch, i) => (
          <span key={i} style={{ animationDelay: `${i * 0.06}s` }}>
            {ch === " " ? " " : ch}
          </span>
        ))}
      </h1>
      <div className="quiz-count" key={left}>
        {left || ""}
      </div>
      <p className="quiz-hint">Prendete il telefono: tre risposte, vince chi indovina per primo!</p>
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
      <div className="quiz-head">
        <span className="quiz-badge">{QUIZ_TITLE}</span>
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
            Ascoltate… <b>{left}</b>
          </div>
        )}
      </div>
      {!reveal && (
        <div className="quiz-timer">
          <div style={{ width: `${Math.min(100, (left / total) * 100)}%` }} />
        </div>
      )}
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
                <div className="quiz-winner-points">{q.points ? `+${q.points} punti in classifica` : "+1 risposta esatta"}</div>
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
        <p className="quiz-hint">Ancora nessun punto: al prossimo quiz!</p>
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
