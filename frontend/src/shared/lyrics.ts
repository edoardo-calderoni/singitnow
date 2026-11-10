import type { LyricLine } from "./api";

const LEAD = 0.9; // anticipo massimo con cui una riga diventa attiva prima di essere cantata
const HOLD = 0.15; // la riga finita resta colorata ancora un istante prima di cambiare
const MAX_LATE = 0.35; // se le righe si sovrappongono, la nuova può comparire al massimo con questo ritardo

/**
 * Istante in cui ogni riga diventa quella attiva. Una riga non "ruba" mai il posto
 * alla precedente finché questa non è stata cantata fino all'ultima sillaba:
 * l'anticipo LEAD si usa solo se la riga precedente è già finita.
 */
export function switchTimes(lines: LyricLine[]): number[] {
  return lines.map((line, i) => {
    const prev = lines[i - 1];
    const early = line.start - LEAD;
    if (!prev) return early;
    return Math.max(early, Math.min(prev.end + HOLD, line.start + MAX_LATE));
  });
}

/** Indice della riga attiva: l'ultima il cui istante di attivazione è passato (-1 = nessuna). */
export function activeIndex(times: number[], t: number): number {
  let lo = 0,
    hi = times.length - 1,
    ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const SPOKEN = 0.7; // quota della parola già colorata quando è stata pronunciata e resta solo la nota tenuta

/**
 * Riempimento (0..1) di una parola al tempo t. Con una nota tenuta (`h`) il colore segue la voce:
 * arriva quasi in fondo mentre la parola viene pronunciata e avanza piano solo sulla nota, invece
 * di spalmarsi uguale su tutta la durata (la parola sembrava colorarsi in ritardo).
 */
export function wordFill(w: { s: number; e: number; h?: number }, t: number): number {
  const len = Math.max(w.e - w.s, 0.05);
  if (w.h === undefined || w.h <= w.s || w.h >= w.e) return Math.max(0, Math.min(1, (t - w.s) / len));
  const at = Math.max(SPOKEN, (w.h - w.s) / len); // mai più lento di prima
  if (t <= w.h) return Math.max(0, (at * (t - w.s)) / (w.h - w.s));
  return Math.min(1, at + ((1 - at) * (t - w.h)) / (w.e - w.h));
}
