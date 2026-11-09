/**
 * Statistiche del canto di un microfono, raccolte nota per nota mentre si canta (dalla PitchBar) e
 * riassunte a fine brano nel pannello dei risultati.
 *
 * Il voto è la media dei voti delle singole note: ogni nota vale per quanto è stata cantata
 * intonata (un po' di indulgenza per respiri e consonanti), alzata del 15%.
 */

/** Nota del brano in corso di canto (accumulatori). */
interface NoteRun {
  idx: number;
  start: number;
  dur: number;
  counts: boolean; // le note incerte non contano
  elapsed: number; // secondi già passati della nota
  voiced: number; // secondi con voce
  hit: number; // secondi intonati (pesati: vicino vale metà)
  absSum: number; // somma di |scarto| (semitoni) per i secondi con voce
  attack: number | null; // secondi dall'inizio della nota alla prima volta intonata
  // stabilità (solo dopo l'attacco): media e varianza dello scarto
  stN: number;
  stSum: number;
  stSq: number;
}

/** Nota finita. */
interface NoteDone {
  dur: number;
  counts: boolean;
  voicedFrac: number;
  score: number; // 0..1
  meanAbs: number | null; // semitoni
  attack: number | null;
  std: number | null; // semitoni, solo per le note lunghe
}

export interface PitchScore {
  total: number; // secondi di note (che contano) nell'intero brano
  sung: number; // secondi di note già passate
  notes: NoteDone[];
  cur: NoteRun | null;
  // tutti i fotogrammi con voce dentro le note: scarto medio e tendenza
  devN: number;
  devAbs: number;
  devSigned: number;
  // note cantate (MIDI reale, campionate) per l'estensione
  range: number[];
  rangeTick: number;
}

const LENIENCY = 0.8; // respiri e consonanti non si possono intonare
const BONUS = 1.15; // +15%: altrimenti arrivare a 100 è quasi impossibile
const LONG_NOTE = 0.6; // s: per la tenuta
const SETTLE = 0.15; // s: la tenuta si misura dopo l'attacco

export function newScore(total: number): PitchScore {
  return { total, sung: 0, notes: [], cur: null, devN: 0, devAbs: 0, devSigned: 0, range: [], rangeTick: 0 };
}

function finish(s: PitchScore) {
  const c = s.cur;
  if (!c) return;
  s.cur = null;
  const std = c.dur >= LONG_NOTE && c.stN >= 6 ? Math.sqrt(Math.max(0, c.stSq / c.stN - (c.stSum / c.stN) ** 2)) : null;
  s.notes.push({
    dur: c.dur,
    counts: c.counts,
    voicedFrac: c.voiced / c.dur,
    score: Math.min(1, c.hit / (c.dur * LENIENCY)),
    meanAbs: c.voiced > 0 ? c.absSum / c.voiced : null,
    attack: c.attack,
    std,
  });
}

/**
 * Un fotogramma di canto. note: [inizio, fine, midi] della nota da cantare adesso (null se non ce
 * n'è), idx: il suo indice, t: posizione nel brano, d: scarto della voce dalla nota in semitoni
 * riportato all'ottava più vicina (null se non si sente voce), sung: nota cantata vera (MIDI).
 */
export function track(
  s: PitchScore,
  note: readonly number[] | null,
  idx: number,
  counts: boolean,
  t: number,
  dt: number,
  d: number | null,
  sung: number | null,
) {
  if (sung != null && ++s.rangeTick % 3 === 0) s.range.push(sung); // ~20 campioni al secondo bastano
  if (!note) {
    finish(s);
    return;
  }
  if (!s.cur || s.cur.idx !== idx) {
    finish(s);
    s.cur = {
      idx, start: note[0], dur: Math.max(0.05, note[1] - note[0]), counts,
      elapsed: 0, voiced: 0, hit: 0, absSum: 0, attack: null, stN: 0, stSum: 0, stSq: 0,
    };
  }
  const c = s.cur;
  c.elapsed += dt;
  if (counts) s.sung += dt;
  if (d == null) return;
  const a = Math.abs(d);
  c.voiced += dt;
  c.absSum += a * dt;
  if (a <= 1) c.hit += dt;
  else if (a <= 2) c.hit += dt * 0.5;
  if (c.attack == null && a <= 1) c.attack = Math.max(0, t - c.start);
  if (c.attack != null && t - c.start >= c.attack + SETTLE) {
    c.stN++;
    c.stSum += d;
    c.stSq += d * d;
  }
  if (counts) {
    s.devN++;
    s.devAbs += a;
    s.devSigned += d;
  }
}

const PARTIAL_MIN = 0.3; // s: la nota in corso conta nel voto dal vivo dopo questo tempo

/**
 * Voto (0..100) fin qui: media dei voti delle note già cantate più quella in corso (per quanto è
 * stata cantata finora). Così il voto parte subito dall'intonazione reale, senza aspettare la fine
 * della prima nota.
 */
export function scoreOf(s: PitchScore): number {
  const scores = s.notes.filter((n) => n.counts).map((n) => n.score);
  const c = s.cur;
  if (c && c.counts && c.elapsed >= PARTIAL_MIN) scores.push(Math.min(1, c.hit / (c.elapsed * LENIENCY)));
  if (!scores.length) return 0;
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return Math.max(0, Math.min(100, Math.round(avg * 100 * BONUS)));
}

/** Si è cantato abbastanza per dare un voto (almeno metà delle note del brano). */
export function enoughSung(s: PitchScore): boolean {
  return s.total > 0 && s.sung >= s.total * 0.5;
}

export type Grade = "A" | "B" | "C" | "D" | "E" | "F";

export function gradeOf(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 50) return "D";
  if (score >= 35) return "E";
  return "F";
}

/** Frasi sotto il voto: per ogni brano se ne sceglie una a caso. */
export const GRADE_TEXT: Record<Grade, string[]> = {
  A: ["Sei la stella del palco!", "A Star is born!", "Una voce straordinaria, COMPLIMENTI!!"],
  B: ["Ottima performance!", "È stato un piacere ascoltarti!"],
  C: ["Non male!", "Diciamo che l'hai portata a casa!"],
  D: ["Bene ma non benissimo...", "Diciamo che poteva andare meglio"],
  E: ["Ci vuole pratica... molta pratica", "Premio l'impegno... ma solo quello"],
  F: ["Spaccatimpani!!!"],
};

function phraseFor(g: Grade): string {
  const list = GRADE_TEXT[g];
  return list[Math.floor(Math.random() * list.length)];
}

export interface Stat {
  key: string;
  label: string;
  /** lunghezza della barra (0..100) */
  value: number;
  /** testo a destra della barra */
  text: string;
  /** spiegazione sotto (facoltativa) */
  hint?: string;
  tone: "good" | "mid" | "bad" | "info";
}

export interface Results {
  score: number;
  grade: Grade;
  phrase: string; // frase sotto il voto (scelta a caso fra quelle del voto)
  stats: Stat[];
}

const NAMES = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"];
export function noteName(midi: number): string {
  const m = Math.round(midi);
  return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((100 * a) / b) : 0);
const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
const toneOf = (v: number): Stat["tone"] => (v >= 70 ? "good" : v >= 40 ? "mid" : "bad");

/** Riassunto di fine brano (chiude anche la nota in corso). */
export function results(s: PitchScore): Results {
  finish(s);
  const notes = s.notes.filter((n) => n.counts);
  const n = notes.length;
  const kind = (x: NoteDone) =>
    x.voicedFrac < 0.25 || x.meanAbs == null ? "skip" : x.meanAbs <= 1 ? "hit" : x.meanAbs <= 2 ? "near" : "off";
  const counts = { hit: 0, near: 0, off: 0, skip: 0 };
  let streak = 0;
  let best = 0;
  for (const x of notes) {
    const k = kind(x);
    counts[k]++;
    streak = k === "hit" ? streak + 1 : 0;
    best = Math.max(best, streak);
  }

  const cents = s.devN ? (100 * s.devAbs) / s.devN : 0;
  const bias = s.devN ? (100 * s.devSigned) / s.devN : 0;
  const precision = clamp(100 - cents / 1.5);
  const biasText =
    Math.abs(bias) < 10 ? "né calante né crescente" : bias < 0 ? `tendi a cantare calante (${Math.round(bias)} cent)` : `tendi a cantare crescente (+${Math.round(bias)} cent)`;

  const attacks = notes.filter((x) => x.dur >= 0.25 && x.attack != null).map((x) => x.attack!);
  const attackMs = attacks.length ? (1000 * attacks.reduce((a, b) => a + b, 0)) / attacks.length : null;
  const timing = attackMs == null ? 0 : clamp(100 - attackMs / 5);

  const stds = notes.filter((x) => x.std != null).map((x) => x.std!);
  const wobble = stds.length ? (100 * stds.reduce((a, b) => a + b, 0)) / stds.length : null;
  const hold = wobble == null ? 0 : clamp(100 - wobble);

  const r = [...s.range].sort((a, b) => a - b);
  const lo = r.length > 10 ? r[Math.floor(r.length * 0.05)] : null;
  const hi = r.length > 10 ? r[Math.floor(r.length * 0.95)] : null;
  const span = lo != null && hi != null ? Math.round(hi - lo) : 0;
  const spanText = span >= 12 ? `${Math.floor(span / 12)} ottav${span >= 24 ? "e" : "a"}${span % 12 ? ` e ${span % 12} semitoni` : ""}` : `${span} semitoni`;

  const score = scoreOf(s);
  const stats: Stat[] = [
    { key: "hit", label: "Note centrate", value: pct(counts.hit, n), text: `${pct(counts.hit, n)}%`, tone: "good" },
    { key: "near", label: "Note quasi giuste", value: pct(counts.near, n), text: `${pct(counts.near, n)}%`, tone: "mid" },
    { key: "off", label: "Note stonate", value: pct(counts.off, n), text: `${pct(counts.off, n)}%`, tone: "bad" },
    { key: "skip", label: "Note non cantate", value: pct(counts.skip, n), text: `${pct(counts.skip, n)}%`, tone: "info" },
    {
      key: "precision", label: "Precisione", value: precision, text: `${precision}%`,
      hint: s.devN ? `in media ${Math.round(cents)} cent di scarto · ${biasText}` : undefined, tone: toneOf(precision),
    },
    {
      key: "timing", label: "Tempismo", value: timing, text: attackMs == null ? "–" : `${timing}%`,
      hint: attackMs == null ? undefined : `prendi la nota in ${Math.round(attackMs)} ms`, tone: toneOf(timing),
    },
    {
      key: "hold", label: "Tenuta", value: hold, text: wobble == null ? "–" : `${hold}%`,
      hint: wobble == null ? "nessuna nota lunga" : `oscilli di ${Math.round(wobble)} cent sulle note lunghe`, tone: toneOf(hold),
    },
    {
      key: "streak", label: "Serie migliore", value: pct(best, n), text: `${best} note`,
      hint: "note centrate di fila", tone: "info",
    },
    {
      key: "range", label: "Estensione", value: clamp((span / 24) * 100), text: lo != null ? spanText : "–",
      hint: lo != null && hi != null ? `da ${noteName(lo)} a ${noteName(hi)}` : undefined, tone: "info",
    },
  ];
  const grade = gradeOf(score);
  return { score, grade, phrase: phraseFor(grade), stats };
}
