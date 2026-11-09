import { useEffect, useState } from "react";
import { api, Competition } from "./api";

/** Stato della competizione condiviso (arriva dal PC con l'evento "competition"). */
let current: Competition = { enabled: false, active: false, standings: [] };
const listeners = new Set<(c: Competition) => void>();

export function setCompetition(c: Competition) {
  current = c;
  listeners.forEach((l) => l(c));
}

/** Competizione accesa, fuori dai componenti (per i calcoli dei tempi). */
export const competitionEnabled = (): boolean => current.enabled;

export function useCompetition(): Competition {
  const [c, setC] = useState(current);
  useEffect(() => {
    listeners.add(setC);
    api.competition().then(setCompetition).catch(() => {});
    return () => void listeners.delete(setC);
  }, []);
  return c;
}

/** Media mostrata in classifica: intera se tonda, altrimenti con un decimale (es. 82 o 81,5). */
export function fmtAverage(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(".", ",");
}
