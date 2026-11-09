/**
 * Suoni del pannello dei risultati: ticchettio delle barre che crescono, rullo di tamburi prima del
 * voto, colpo di piatto e reazione del pubblico (applausi da A a C, «BUUU» da D a F).
 *
 * La reazione del pubblico usa i file media/sounds/grade-a.mp3 … grade-f.mp3 se ci sono; altrimenti
 * l'applauso di sempre (più forte per A, più leggero per C) e un «BUUU» sintetizzato, sempre più
 * marcato da D a F. Tutto il resto è generato al momento: nessun file da scaricare.
 */
import type { Grade } from "./performance";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function audio(): { ctx: AudioContext; out: GainNode } {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return { ctx, out: master! };
}

function noiseBuffer(c: AudioContext, seconds: number): AudioBuffer {
  const b = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

/**
 * Battito morbido di una barra che cresce: sempre lo stesso suono, con il tono che sale insieme alla
 * lunghezza della barra (len 0..1, uguale per tutte le barre: 0 = vuota, 1 = piena).
 */
export function tick(len: number) {
  const { ctx: c, out } = audio();
  const t = c.currentTime;
  const o = c.createOscillator();
  const lp = c.createBiquadFilter();
  const g = c.createGain();
  o.type = "sine";
  o.frequency.value = 220 * Math.pow(2, Math.max(0, Math.min(1, len)) * 1.5); // fino a un'ottava e mezza sopra
  lp.type = "lowpass";
  lp.frequency.value = 900;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.05, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
  o.connect(lp).connect(g).connect(out);
  o.start(t);
  o.stop(t + 0.12);
}

/** Rullo di tamburi che cresce per `seconds`, poi colpo di piatto. */
export function drumroll(seconds: number) {
  const { ctx: c, out } = audio();
  const t0 = c.currentTime;
  const noise = noiseBuffer(c, 0.08);
  const rate = 26; // colpi al secondo
  for (let i = 0; i < seconds * rate; i++) {
    const t = t0 + i / rate + (Math.random() - 0.5) * 0.006;
    const p = i / (seconds * rate);
    const src = c.createBufferSource();
    src.buffer = noise;
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1800 + Math.random() * 400;
    bp.Q.value = 0.8;
    const g = c.createGain();
    const v = 0.05 + 0.3 * p * p;
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    src.connect(bp).connect(g).connect(out);
    src.start(t);
  }
  // piatto + cassa sul voto
  const t = t0 + seconds;
  const crash = c.createBufferSource();
  crash.buffer = noiseBuffer(c, 2);
  const hp = c.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 3500;
  const cg = c.createGain();
  cg.gain.setValueAtTime(0.5, t);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
  crash.connect(hp).connect(cg).connect(out);
  crash.start(t);
  const kick = c.createOscillator();
  const kg = c.createGain();
  kick.frequency.setValueAtTime(140, t);
  kick.frequency.exponentialRampToValueAtTime(45, t + 0.25);
  kg.gain.setValueAtTime(0.8, t);
  kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
  kick.connect(kg).connect(out);
  kick.start(t);
  kick.stop(t + 0.45);
}

// ------------------------------------------------------------------ reazione del pubblico
const cache = new Map<string, Promise<AudioBuffer | null>>();
function load(url: string): Promise<AudioBuffer | null> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => (b ? audio().ctx.decodeAudioData(b) : null))
      .catch(() => null);
    cache.set(url, p);
  }
  return p;
}

/** Carica in anticipo i suoni del pubblico (mentre crescono le barre). */
export function preloadCrowd(grade: Grade) {
  load(`/sounds/grade-${grade.toLowerCase()}.mp3`);
  load("/sounds/applause.mp3");
}

const CROWD_FADE = 3; // s: il pubblico sfuma piano quando il pannello si chiude
const CROWD_VOLUME = 0.7; // volume della reazione del pubblico (applausi e «BUUU»)
const APPLAUSE_GAIN: Partial<Record<Grade, number>> = { A: 1, B: 0.55, C: 0.25 };
const BOO: Partial<Record<Grade, { voices: number; gain: number; seconds: number }>> = {
  D: { voices: 4, gain: 0.25, seconds: 1.6 },
  E: { voices: 8, gain: 0.5, seconds: 2.4 },
  F: { voices: 14, gain: 0.85, seconds: 3.2 },
};

/** «BUUU» di una piccola folla: voci basse che scendono, filtrate sulla vocale «u». */
function boo(c: AudioContext, out: AudioNode, voices: number, gain: number, seconds: number): () => void {
  const t = c.currentTime;
  const bus = c.createGain();
  bus.gain.setValueAtTime(0.0001, t);
  bus.gain.exponentialRampToValueAtTime(gain, t + 0.35);
  bus.gain.setValueAtTime(gain, t + seconds - 0.6);
  bus.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 420; // la «u» ha le formanti basse
  lp.Q.value = 1.2;
  const f1 = c.createBiquadFilter();
  f1.type = "peaking";
  f1.frequency.value = 300;
  f1.gain.value = 9;
  bus.connect(lp).connect(f1).connect(out);
  const nodes: OscillatorNode[] = [];
  for (let i = 0; i < voices; i++) {
    const o = c.createOscillator();
    o.type = "sawtooth";
    const f = 95 + Math.random() * 90;
    const start = t + Math.random() * 0.25;
    o.frequency.setValueAtTime(f * 1.08, start);
    o.frequency.linearRampToValueAtTime(f * 0.88, t + seconds);
    const vib = c.createOscillator();
    const vg = c.createGain();
    vib.frequency.value = 4 + Math.random() * 2;
    vg.gain.value = f * 0.02;
    vib.connect(vg).connect(o.frequency);
    const g = c.createGain();
    g.gain.value = 0.6 / Math.sqrt(voices);
    o.connect(g).connect(bus);
    o.start(start);
    vib.start(start);
    o.stop(t + seconds + 0.05);
    vib.stop(t + seconds + 0.05);
    nodes.push(o);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const n = c.currentTime;
    bus.gain.cancelScheduledValues(n);
    bus.gain.setValueAtTime(bus.gain.value, n);
    bus.gain.linearRampToValueAtTime(0, n + CROWD_FADE);
  };
}

/**
 * Reazione del pubblico al voto (una volta sola). Restituisce quanto dura (s) e la funzione che la
 * sfuma se il pannello si chiude prima.
 */
export async function crowd(grade: Grade): Promise<{ seconds: number; stop: () => void }> {
  const { ctx: c, out } = audio();
  const own = await load(`/sounds/grade-${grade.toLowerCase()}.mp3`);
  const applause = own ? null : APPLAUSE_GAIN[grade] != null ? await load("/sounds/applause.mp3") : null;
  const buf = own ?? applause;
  if (buf) {
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    const v = (own ? 1 : APPLAUSE_GAIN[grade]!) * CROWD_VOLUME;
    const t = c.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.15);
    src.connect(g).connect(out);
    src.start(t);
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      const n = c.currentTime;
      g.gain.cancelScheduledValues(n);
      g.gain.setValueAtTime(g.gain.value, n);
      g.gain.linearRampToValueAtTime(0, n + CROWD_FADE);
      src.stop(n + CROWD_FADE + 0.05);
    };
    src.onended = () => (stopped = true);
    return { seconds: buf.duration, stop };
  }
  const b = BOO[grade];
  return b ? { seconds: b.seconds, stop: boo(c, out, b.voices, b.gain * CROWD_VOLUME, b.seconds) } : { seconds: 0, stop: () => {} };
}
