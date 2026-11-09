/**
 * Mix in battuta delle modalità DJ e Jukebox, come farebbe un DJ con due giradischi:
 *
 * 1. Il brano successivo si carica in anticipo, fermo (vedi App: il player «in attesa»).
 * 2. Sul brano che finisce si sceglie un primo tempo di battuta 16 battiti (4 battute) prima
 *    della fine del ritmo; il successivo parte esattamente lì, dal suo primo tempo di battuta,
 *    alla velocità che porta il suo BPM uguale a quello del brano che finisce (pitch del
 *    giradischi, al massimo ±6%; i tempi doppi o dimezzati valgono). Stesso AudioContext, quindi
 *    l'attacco cade al campione.
 * 3. Durante le 4 battute: il nuovo entra senza bassi e sale di volume; a metà i bassi si
 *    scambiano (quelli del nuovo entrano, quelli del vecchio escono) e il vecchio sfuma a zero.
 * 4. Finito il mix il nuovo brano torna piano piano alla sua velocità originale.
 *
 * In ogni caso i lunghi silenzi all'inizio del brano nuovo e alla fine di quello vecchio si saltano.
 * Se il ritmo di uno dei due non è regolare (o manca la griglia, o i BPM sono troppo diversi) si fa
 * una dissolvenza incrociata di MIX_SECONDS senza toccare la velocità.
 */
import type { Envelope, KaraokeEngine } from "../shared/engine";

export interface Grid {
  first: number;
  period: number;
  bpm: number;
  count: number;
  downbeat: number;
  steady: boolean;
}
export interface Beats {
  /** primo e ultimo istante in cui il brano si sente (0 = sconosciuto) */
  start?: number;
  end?: number;
  intro: Grid | null;
  outro: Grid | null;
}

export const MIX_SECONDS = 10; // dissolvenza senza battuta
export const PRELOAD_SECONDS = 45; // il brano successivo si carica quando ne mancano tanti alla fine
const MIX_BEATS = 16; // durata del mix in battuta (4 battute)
const MAX_PITCH = 0.06; // variazione massima di velocità per mettere in battuta
const BASS_CUT = -26; // dB: bassi tolti
const RATE_BACK_SECONDS = 20; // ritorno alla velocità originale dopo il mix

export interface MixPlan {
  synced: boolean; // in battuta (velocità adattata) o semplice dissolvenza
  outStart: number; // posizione nel brano che finisce in cui parte il mix
  inStart: number; // posizione del brano nuovo da cui parte
  length: number; // durata del mix (s)
  rate: number; // velocità del brano nuovo durante il mix
  beat: number; // durata di un battito (s), per lo scambio dei bassi
}

/** Fine della musica: ultimo battito della griglia finale, senza contare il silenzio in coda. */
function musicEnd(b: Beats | null, duration: number): number {
  const heard = b?.end && b.end > 1 ? Math.min(duration, b.end) : duration;
  const o = b?.outro;
  if (!o || !o.count) return heard;
  return Math.min(heard, o.first + o.count * o.period);
}

/** Da dove si sente il brano: i lunghi silenzi iniziali si saltano (con un attimo di margine). */
function musicStart(b: Beats | null): number {
  return Math.max(0, (b?.start ?? 0) - 0.05);
}

export function planMix(outBeats: Beats | null, outDuration: number, inBeats: Beats | null): MixPlan {
  const o = outBeats?.outro;
  const i = inBeats?.intro;
  if (o?.steady && i?.steady && o.count > MIX_BEATS + 4) {
    // tempo del nuovo uguale al vecchio: 1:1, oppure il doppio o la metà
    let best = { rate: 0, err: Infinity };
    for (const k of [1, 2, 0.5]) {
      const rate = o.bpm / (i.bpm * k);
      if (Math.abs(rate - 1) < best.err) best = { rate, err: Math.abs(rate - 1) };
    }
    if (best.err <= MAX_PITCH) {
      // primo tempo di battuta del vecchio, 16 battiti prima dell'ultimo battito
      const last = o.count - 1;
      let s = last - MIX_BEATS;
      s -= (((s - o.downbeat) % 4) + 4) % 4;
      // primo tempo di battuta del nuovo dove il brano già si sente (salta il silenzio iniziale)
      const heard = musicStart(inBeats);
      let d = i.downbeat;
      while (i.first + d * i.period < Math.max(0, heard - 0.1)) d += 4;
      const outStart = o.first + s * o.period;
      if (s >= 0 && outStart > 0 && outStart + MIX_BEATS * o.period <= Math.min(outDuration, musicEnd(outBeats, outDuration) + o.period)) {
        return {
          synced: true,
          outStart,
          inStart: i.first + d * i.period,
          length: MIX_BEATS * o.period,
          rate: best.rate,
          beat: o.period,
        };
      }
    }
  }
  const end = musicEnd(outBeats, outDuration);
  return { synced: false, outStart: Math.max(0, end - MIX_SECONDS), inStart: musicStart(inBeats), length: MIX_SECONDS, rate: 1, beat: 0.5 };
}

export interface MixSide {
  engine: KaraokeEngine;
  volume: number;
}

/**
 * Programma il mix: `start` è l'istante dell'AudioContext dell'attacco (si sente lì).
 * Restituisce la funzione che lo annulla (solo prima dell'attacco: dopo il mix è avviato).
 */
export function runMix(
  out: MixSide,
  inc: MixSide,
  plan: MixPlan,
  start: number,
  cb: { onStart: () => void; onEnd: () => void },
): () => void {
  const end = start + plan.length;
  const mid = start + plan.length / 2;
  inc.engine.playAt(start, plan.inStart, plan.rate);
  let outEnv: Envelope, inEnv: Envelope;
  if (plan.synced) {
    // il nuovo sale nella prima metà (senza bassi), il vecchio scende nella seconda
    inEnv = [[start, 0], [mid, inc.volume]];
    outEnv = [[mid, out.volume], [end, 0]];
    const swap = plan.beat; // lo scambio dei bassi dura un battito, sul primo tempo della 3ª battuta
    inc.engine.envelope("bass", [[start, BASS_CUT], [mid, BASS_CUT], [mid + swap, 0]]);
    out.engine.envelope("bass", [[mid, 0], [mid + swap, BASS_CUT]]);
  } else {
    inEnv = [[start, 0], [end, inc.volume]];
    outEnv = [[start, out.volume], [end, 0]];
  }
  inc.engine.envelope("master", [[inc.engine.now, 0], ...inEnv]);
  out.engine.envelope("master", outEnv);

  const ms = (t: number) => Math.max(0, (t - out.engine.now) * 1000);
  let started = false;
  const timers = [
    window.setTimeout(() => {
      started = true;
      cb.onStart();
    }, ms(start)),
    window.setTimeout(() => {
      out.engine.pause();
      inc.engine.rampRate(1, RATE_BACK_SECONDS); // il nuovo torna piano alla sua velocità
      cb.onEnd();
    }, ms(end)),
  ];
  return () => {
    if (started) return;
    timers.forEach((t) => window.clearTimeout(t));
    inc.engine.pause();
    inc.engine.seek(0);
    inc.engine.setRate(1);
    inc.engine.envelope("bass", [[inc.engine.now, 0]]);
    out.engine.envelope("bass", [[out.engine.now, 0]]);
    out.engine.setMasterVolume(out.volume);
  };
}

// ------------------------------------------------------------------ brani pronti per il mix
/** Il player del brano successivo, caricato e fermo, si registra qui; quello in corso lo trova. */
export interface CuedPlayer {
  engine: KaraokeEngine;
  beats: Beats | null;
  volume: () => number;
}
const cued = new Map<string, CuedPlayer>();
const listeners = new Set<() => void>();

export function setCued(entryId: string, p: CuedPlayer | null) {
  if (p) cued.set(entryId, p);
  else cued.delete(entryId);
  listeners.forEach((l) => l());
}
export function getCued(entryId: string | undefined): CuedPlayer | undefined {
  return entryId ? cued.get(entryId) : undefined;
}
export function onCuedChange(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}
