import { useEffect, useState } from "react";
import { api } from "../shared/api";
import { Avatar } from "../shared/Avatar";
import { useTick } from "../shared/queue";
import { OPTION_LETTERS, QUIZ_TITLE, quizLeft, useQuiz } from "../shared/quiz";
import { vibrate } from "./Live";

/**
 * Quiz musicale sul telefono: a tutto schermo, tre pulsanti grandi per rispondere mentre la TV fa
 * sentire il pezzo; poi com'è andata e la classifica.
 */
export function QuizScreen({ name }: { name: string }) {
  const q = useQuiz();
  useTick(250);
  const [mine, setMine] = useState<{ id: string; choice: number } | null>(null);
  const [error, setError] = useState("");
  const id = q?.id;
  useEffect(() => setError(""), [id]);
  // domanda aperta: una vibrazione per avvisare
  const phase = q?.phase;
  useEffect(() => {
    if (phase === "question") vibrate([120]);
  }, [phase, id]);

  if (!q) return null;
  const me = name.trim().toLowerCase();
  const answered = q.answered.some((n) => n.trim().toLowerCase() === me);
  const myChoice = mine?.id === q.id ? mine.choice : (q.answers ?? []).find((a) => a.name.trim().toLowerCase() === me)?.choice;
  const reveal = q.phase === "reveal" || q.phase === "ranking";
  const iWon = !!q.winner && q.winner.trim().toLowerCase() === me;

  const send = (i: number) => {
    if (!name || answered || myChoice != null) return;
    setMine({ id: q.id, choice: i });
    api.quizAnswer(name, i).catch((e) => {
      setError(e.message);
      setMine(null);
    });
  };

  return (
    <div className={`m-quiz m-quiz-${q.phase}`}>
      <div className="m-quiz-badge">{QUIZ_TITLE}</div>
      {q.phase === "intro" && (
        <div className="m-quiz-intro">
          <div className="m-quiz-count" key={quizLeft(q)}>
            {quizLeft(q) || ""}
          </div>
          <p>Preparati: fra poco la TV fa sentire un pezzo di un brano. Chi indovina per primo vince!</p>
        </div>
      )}
      {(q.phase === "question" || q.phase === "reveal") && (
        <>
          <h2 className="m-quiz-q">{q.question}</h2>
          {q.phase === "question" && (
            <div className="m-quiz-timer">
              <div style={{ width: `${Math.min(100, (quizLeft(q) / (q.kind === "next_word" ? 22 : 20)) * 100)}%` }} />
            </div>
          )}
          <div className="m-quiz-options">
            {q.options.map((o, i) => (
              <button
                key={i}
                type="button"
                className={`m-quiz-opt opt-${i} ${myChoice === i ? "mine" : ""} ${reveal ? (i === q.correct ? "right" : "wrong") : myChoice != null && myChoice !== i ? "off" : ""}`}
                disabled={reveal || myChoice != null || answered || !name}
                onClick={() => send(i)}
              >
                <span className="m-quiz-letter">{OPTION_LETTERS[i]}</span>
                <span className="m-quiz-text">{o}</span>
              </button>
            ))}
          </div>
          {error && <div className="m-quiz-msg err">{error}</div>}
          {q.phase === "question" && (
            <div className="m-quiz-msg">
              {!name ? "Entra con il tuo nome per giocare" : myChoice != null || answered ? "Risposta inviata, incrociamo le dita…" : "Tocca la risposta giusta, prima degli altri!"}
            </div>
          )}
          {q.phase === "reveal" && (
            <div className={`m-quiz-result ${iWon ? "won" : ""}`}>
              {iWon ? (
                <>
                  <div className="m-quiz-big">🎉 Hai indovinato!</div>
                  <div>{q.points ? `+${q.points} punti in classifica` : "+1 risposta esatta"}</div>
                </>
              ) : q.winner ? (
                <>
                  <Avatar name={q.winner} className="m-quiz-wavatar" />
                  <div>
                    <b>{q.winner}</b> ha indovinato{myChoice != null ? ": peccato!" : "!"}
                  </div>
                </>
              ) : (
                <div>{myChoice != null ? "Sbagliato, ma nessuno ha indovinato!" : "Nessuno ha indovinato!"}</div>
              )}
              {q.song && (
                <div className="m-quiz-song">
                  «{q.song.title}» {q.song.artist && <>di {q.song.artist}</>} {q.song.year && <>({q.song.year})</>}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {q.phase === "ranking" && (
        <div className="m-quiz-ranking">
          <h2 className="m-quiz-q">{q.ranking?.kind === "competition" ? "Classifica della Competizione" : "Classifica del quiz"}</h2>
          <ol>
            {(q.ranking?.rows ?? []).map((r, i) => (
              <li key={r.name} className={r.name.trim().toLowerCase() === me ? "me" : ""}>
                <span>{i + 1}</span>
                <Avatar name={r.name} />
                <span className="m-quiz-rname">{r.name}</span>
                <b>{q.ranking?.kind === "competition" ? r.value.toFixed(1) : r.value}</b>
              </li>
            ))}
          </ol>
          <div className="m-quiz-msg">Fra poco si riparte con la musica</div>
        </div>
      )}
    </div>
  );
}
