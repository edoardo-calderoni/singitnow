import { useSyncExternalStore } from "react";

/** Quiz musicale fra un brano e l'altro (stato condiviso dal PC in tempo reale). */
export type QuizPhase = "intro" | "question" | "reveal" | "ranking";

export interface QuizState {
  id: string;
  phase: QuizPhase;
  kind: "title" | "artist" | "year" | "next_word";
  question: string;
  options: string[];
  /** secondi alla fine della fase, quando è arrivato lo stato */
  remaining: number;
  clip: { start: number; end: number };
  /** chi ha già risposto (senza dire cosa, finché la domanda è aperta) */
  answered: string[];
  // dalla fase «reveal»
  correct?: number;
  answers?: { name: string; choice: number }[];
  winner?: string | null;
  points?: number;
  song?: { title: string; artist: string; year: number | null; thumbnail_url?: string } | null;
  // fase «ranking»
  ranking?: { kind: "competition" | "quiz"; rows: { name: string; value: number; quiz?: number }[] };
  /** istante locale (performance.now) della fine della fase */
  until: number;
}

let state: QuizState | null = null;
const subs = new Set<() => void>();

export function setQuiz(data: Omit<QuizState, "until"> | { phase: null } | null | undefined) {
  state = data && data.phase ? { ...(data as Omit<QuizState, "until">), until: performance.now() + (data as QuizState).remaining * 1000 } : null;
  subs.forEach((f) => f());
}

export function useQuiz(): QuizState | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
  );
}

/** Secondi che mancano alla fine della fase (arrotondati per eccesso). */
export const quizLeft = (q: QuizState): number => Math.max(0, Math.ceil((q.until - performance.now()) / 1000));

export const QUIZ_TITLE = "QUIZ MUSICALE";
export const OPTION_LETTERS = ["A", "B", "C"];
