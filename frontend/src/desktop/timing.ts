/**
 * Operazioni dell'editor dei tempi del testo: ognuna parte da una copia delle righe e restituisce
 * le righe corrette (le righe toccate diventano «corrette a mano»). Mai una parola che inizia prima
 * della precedente, mai una parola più corta di MIN.
 */
import type { LyricLine, LyricWord } from "../shared/api";

/** k: posizione della parola nel testo salvato (serve a salvare le parole eliminate) */
export type EdWord = LyricWord & { k?: number };
/** id: posizione della riga nel testo salvato (per rimetterla com'era anche dopo eliminazioni) */
export type EdLine = Omit<LyricLine, "words"> & { manual?: boolean; id?: number; words: EdWord[] };

/** Righe caricate nell'editor: ogni riga e ogni parola si porta dietro la sua posizione originale. */
export function withIds(lines: LyricLine[]): EdLine[] {
  let k = 0;
  return lines.map((l, id) => ({ ...l, id, words: l.words.map((w) => ({ ...w, k: k++ })) }));
}

export const MIN = 0.05; // s: durata minima di una parola

export function clone(lines: EdLine[]): EdLine[] {
  return lines.map((l) => ({ ...l, words: l.words.map((w) => ({ ...w })) }));
}

function touch(l: EdLine): void {
  l.manual = true;
  if (l.words.length) {
    l.start = l.words[0]!.s;
    l.end = l.words[l.words.length - 1]!.e;
  }
}

/** Parola prima e dopo (anche nelle righe vicine). */
function neighbours(ls: EdLine[], i: number, j: number) {
  const prev = j > 0 ? { i, j: j - 1 } : i > 0 && ls[i - 1]!.words.length ? { i: i - 1, j: ls[i - 1]!.words.length - 1 } : null;
  const line = ls[i]!;
  const next =
    j + 1 < line.words.length ? { i, j: j + 1 } : i + 1 < ls.length && ls[i + 1]!.words.length ? { i: i + 1, j: 0 } : null;
  return { prev, next };
}

const W = (ls: EdLine[], p: { i: number; j: number }) => ls[p.i]!.words[p.j]!;

/** Sposta una riga intera di `delta` secondi (le parole la seguono), senza scavalcare le vicine. */
export function shiftLine(src: EdLine[], i: number, delta: number): EdLine[] {
  const ls = clone(src);
  const line = ls[i];
  if (!line || !line.words.length) return ls;
  const first = line.words[0]!;
  const last = line.words[line.words.length - 1]!;
  const prev = ls[i - 1]?.words;
  const next = ls[i + 1]?.words;
  const lo = (prev?.length ? prev[prev.length - 1]!.s + MIN : 0) - first.s;
  const hi = next?.length ? next[0]!.s - MIN - last.s : Infinity;
  const d = Math.min(Math.max(delta, lo), hi);
  for (const w of line.words) {
    w.s += d;
    w.e += d;
    if (w.h !== undefined) w.h += d;
  }
  if (prev?.length) {
    const p = prev[prev.length - 1]!;
    if (p.e > first.s) p.e = Math.max(p.s + MIN, first.s);
  }
  if (next?.length && last.e > next[0]!.s) last.e = Math.max(last.s + MIN, next[0]!.s);
  touch(line);
  if (prev?.length) touch(ls[i - 1]!);
  return ls;
}

/** Sposta questa riga e tutte quelle dopo di `delta` secondi. */
export function shiftFrom(src: EdLine[], i: number, delta: number): EdLine[] {
  const ls = clone(src);
  const first = ls[i]?.words[0];
  if (!first) return ls;
  const prev = ls[i - 1]?.words;
  const lo = (prev?.length ? prev[prev.length - 1]!.s + MIN : 0) - first.s;
  const d = Math.max(delta, lo);
  for (const l of ls.slice(i)) {
    for (const w of l.words) {
      w.s += d;
      w.e += d;
      if (w.h !== undefined) w.h += d;
    }
    touch(l);
  }
  if (prev?.length) {
    const p = prev[prev.length - 1]!;
    if (p.e > first.s) {
      p.e = Math.max(p.s + MIN, first.s);
      touch(ls[i - 1]!);
    }
  }
  return ls;
}

/** Cambia inizio e/o fine di una parola; le parole vicine si accorciano se serve. */
export function setWord(src: EdLine[], i: number, j: number, s?: number, e?: number): EdLine[] {
  const ls = clone(src);
  const w = ls[i]?.words[j];
  if (!w) return ls;
  const { prev, next } = neighbours(ls, i, j);
  // limiti: dopo l'inizio della parola prima, prima della fine della parola dopo
  const lo = prev ? W(ls, prev).s + MIN : 0;
  const hi = next ? W(ls, next).e - MIN : Infinity;
  let ns = Math.max(s ?? w.s, lo);
  let ne = Math.min(Math.max(e ?? w.e, ns + MIN), hi);
  if (ne - ns < MIN) ns = Math.max(lo, ne - MIN); // spazio strettissimo: si cede sull'inizio
  w.s = ns;
  w.e = ne;
  if (prev && W(ls, prev).e > ns) {
    W(ls, prev).e = ns;
    touch(ls[prev.i]!);
  }
  if (next && W(ls, next).s < ne) {
    W(ls, next).s = ne;
    touch(ls[next.i]!);
  }
  delete w.h; // la nota tenuta calcolata non vale più
  touch(ls[i]!);
  return ls;
}

/** Sposta una parola (inizio e fine insieme) di `delta` secondi. */
export function moveWord(src: EdLine[], i: number, j: number, delta: number): EdLine[] {
  const w = src[i]?.words[j];
  if (!w) return clone(src);
  const { prev, next } = neighbours(src, i, j);
  const lo = (prev ? W(src, prev).s + MIN : 0) - w.s;
  const hi = next ? W(src, next).e - MIN - w.e : Infinity;
  const d = Math.min(Math.max(delta, lo), hi);
  return setWord(src, i, j, w.s + d, w.e + d);
}

/** Correzione al volo: la riga parte adesso (le sue parole la seguono). */
export function tapLine(src: EdLine[], i: number, t: number): EdLine[] {
  const first = src[i]?.words[0];
  return first ? shiftLine(src, i, t - first.s) : clone(src);
}

/** Correzione al volo: la parola parte adesso; la parola prima della stessa riga finisce qui. */
export function tapWord(src: EdLine[], i: number, j: number, t: number): EdLine[] {
  const w = src[i]?.words[j];
  if (!w) return clone(src);
  const dur = Math.max(w.e - w.s, 0.2);
  const { next } = neighbours(src, i, j);
  let e = w.e > t + MIN ? w.e : t + dur;
  if (next) e = Math.min(e, Math.max(src[next.i]!.words[next.j]!.s, t + MIN));
  let ls = setWord(src, i, j, t, Math.max(e, t + MIN));
  if (j > 0) {
    const p = ls[i]!.words[j - 1]!;
    if (p.e < ls[i]!.words[j]!.s) ls = setWord(ls, i, j - 1, undefined, ls[i]!.words[j]!.s);
  }
  return ls;
}

/** Riga riportata com'era all'apertura dell'editor (parole eliminate comprese). */
export function restoreLine(src: EdLine[], original: EdLine[], i: number): EdLine[] {
  const ls = clone(src);
  const o = original.find((x) => x.id === ls[i]?.id);
  if (o) ls[i] = { ...o, words: o.words.map((w) => ({ ...w })) };
  return ls;
}

/**
 * Riga riscritta (dall'elenco delle righe). Se le parole restano tante quante erano (un refuso)
 * ognuna tiene i suoi tempi; altrimenti le parole si distribuiscono nello spazio della riga, in
 * proporzione alla lunghezza. Le parole perdono il riferimento al testo salvato: la riga si salva
 * come riscritta. Una riga svuotata viene eliminata.
 */
export function editLineText(src: EdLine[], i: number, text: string): EdLine[] {
  const l = src[i];
  if (!l) return clone(src);
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return deleteLine(src, i);
  if (tokens.join(" ") === l.words.map((w) => w.t).join(" ")) return clone(src);
  const ls = clone(src);
  const line = ls[i]!;
  const start = line.words[0]?.s ?? line.start;
  const end = Math.max(line.words[line.words.length - 1]?.e ?? line.end, start + 0.2 * tokens.length);
  if (tokens.length === line.words.length) {
    line.words = line.words.map((w, k) => ({ t: tokens[k]!, s: w.s, e: w.e }));
  } else {
    const weights = tokens.map((t) => t.length + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = start;
    line.words = tokens.map((tok, k) => {
      const d = ((end - start) * weights[k]!) / total;
      const w = { t: tok, s: t, e: t + d };
      t += d;
      return w;
    });
  }
  line.text = tokens.join(" ");
  delete line.orig;
  touch(line);
  return ls;
}

/** Elimina una riga intera. */
export function deleteLine(src: EdLine[], i: number): EdLine[] {
  const ls = clone(src);
  ls.splice(i, 1);
  return ls;
}

/** Elimina una parola (se la riga resta vuota, sparisce anche la riga). */
export function deleteWord(src: EdLine[], i: number, j: number): EdLine[] {
  const ls = clone(src);
  const l = ls[i];
  if (!l) return ls;
  l.words.splice(j, 1);
  if (!l.words.length) {
    ls.splice(i, 1);
    return ls;
  }
  l.text = l.words.map((w) => w.t).join(" ");
  if (l.orig !== undefined) l.orig = l.words.map((w) => w.o ?? w.t).join("");
  touch(l);
  return ls;
}
