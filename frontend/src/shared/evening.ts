import { useSyncExternalStore } from "react";

/**
 * Fine della serata (evento "evening" del PC): un amministratore ha premuto «Concludi la serata»
 * (`closing`, con l'ultimo brano `lastEntry`) oppure la serata è già conclusa (`ended`).
 */
export interface EveningState {
  closing: boolean;
  lastEntry: string | null;
  ended: boolean;
}

let state: EveningState = { closing: false, lastEntry: null, ended: false };
const subs = new Set<() => void>();

export function setEvening(data: { closing?: boolean; last_entry?: string | null; ended?: boolean } | null | undefined) {
  const next: EveningState = {
    closing: !!data?.closing,
    lastEntry: data?.last_entry ?? null,
    ended: !!data?.ended,
  };
  if (next.closing === state.closing && next.lastEntry === state.lastEntry && next.ended === state.ended) return;
  state = next;
  subs.forEach((f) => f());
}

export function useEvening(): EveningState {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
  );
}

/** La voce della playlist è l'ultimo brano della serata (fuori dai componenti). */
export const isEveningLast = (entryId: string | undefined | null): boolean =>
  !!entryId && state.closing && state.lastEntry === entryId;
