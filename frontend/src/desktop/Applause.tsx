import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "../shared/Avatar";

interface Bubble {
  key: number;
  name: string;
  x: number; // posizione orizzontale di partenza (0..1)
  drift: number; // deriva laterale durante la salita (vw)
  dur: number; // durata della salita (s)
  size: number; // scala della bolla
}

const MAX_BUBBLES = 80;

// ------------------------------------------------------------------ suono dell'applauso
const SOUND_URL = "/sounds/applause.mp3";
const FADE_IN = 0.12; // s
const FADE_OUT = 0.5; // s
const MAX_VOICES = 24; // applausi che suonano insieme al massimo
// Ognuno ha un solo suono d'applauso alla volta: i tocchi mentre suona fanno salire solo le bolle,
// e il tocco dopo la fine del suono lo fa ripartire.
const PER_PERSON = 1;
// L'effetto (media -20 dB) è forte più o meno quanto una base: un applauso da solo resta circa
// 10 dB sotto la musica, si sente bene ma non la copre. Ogni persona in più che applaude insieme
// alza tutti gli applausi di CROWD_STEP dB, fino a CROWD_MAX dB in più: con tutta la sala che
// applaude si arriva a 2-3 dB sotto la musica, mai sopra.
const VOICE_GAIN = 0.45;
const CROWD_STEP = 1.5; // dB per persona in più
const CROWD_MAX = 7.5; // dB in più al massimo (circa 6 persone)
/** Guadagno complessivo con n applausi insieme: compensa la somma naturale (10·log10 n dB) per arrivare a quella voluta. */
const crowdGain = (n: number) =>
  n <= 1 ? 1 : Math.pow(10, (Math.min(CROWD_STEP * (n - 1), CROWD_MAX) - 10 * Math.log10(n)) / 20);

let ctx: AudioContext | null = null;
let bus: GainNode | null = null;
let songVolume = 1; // volume generale del player: gli applausi lo seguono
let sound: Promise<AudioBuffer | null> | null = null;
const voices: { name: string; src: AudioBufferSourceNode }[] = [];

function audio() {
  if (!ctx) {
    ctx = new AudioContext();
    // niente compressore: in Web Audio alza anche i suoni deboli (guadagno di compensazione automatico)
    bus = ctx.createGain();
    bus.gain.value = songVolume;
    bus.connect(ctx.destination);
    sound = fetch(SOUND_URL)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => ctx!.decodeAudioData(b))
      .catch(() => null);
  }
  return { ctx, bus: bus!, sound: sound! };
}

/** Gli applausi seguono il volume generale della canzone (abbassando la musica si abbassano anche loro). */
export function setApplauseVolume(v: number) {
  songVolume = Math.max(0, Math.min(1, v));
  updateBus();
}

/** Volume complessivo: segue quello della canzone e si riduce un po' quando gli applausi sono tanti. */
function updateBus() {
  if (ctx && bus) bus.gain.setTargetAtTime(songVolume * crowdGain(voices.length), ctx.currentTime, 0.15);
}

/** Carica l'effetto in anticipo, così il primo applauso suona subito. */
export function preloadApplause() {
  audio();
}

/**
 * Fa partire un applauso che si somma a quelli già in corso: ognuno ha velocità, posizione
 * stereo e volume un po' diversi, così più persone insieme suonano come un pubblico vero.
 */
async function playApplause(name: string) {
  const { ctx, bus, sound } = audio();
  const buf = await sound;
  if (!buf) return;
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});
  if (voices.filter((v) => v.name === name).length >= PER_PERSON) return;
  if (voices.length >= MAX_VOICES) return;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = 0.96 + Math.random() * 0.08;
  const len = buf.duration / src.playbackRate.value;
  const g = ctx.createGain();
  const peak = VOICE_GAIN * (0.75 + Math.random() * 0.25);
  const t0 = ctx.currentTime + Math.random() * 0.06;
  // fade-in rapido all'inizio, fade-out rapido alla fine
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + FADE_IN);
  g.gain.setValueAtTime(peak, t0 + Math.max(FADE_IN, len - FADE_OUT));
  g.gain.linearRampToValueAtTime(0, t0 + len);
  const pan = ctx.createStereoPanner();
  pan.pan.value = (Math.random() - 0.5) * 1.2;
  src.connect(g).connect(pan).connect(bus);
  const voice = { name, src };
  voices.push(voice);
  updateBus();
  src.onended = () => {
    voices.splice(voices.indexOf(voice), 1);
    updateBus();
    src.disconnect();
    g.disconnect();
    pan.disconnect();
  };
  src.start(t0);
  src.stop(t0 + len);
} // con tantissimi applausi si tengono le bolle più recenti

/** Ovazione del pubblico (vincitore della competizione): tanti applausi insieme, un po' sfalsati. */
export function cheer(people = 9) {
  for (let i = 0; i < people; i++) {
    window.setTimeout(() => playApplause(`__cheer${i}`), i * 180 + Math.random() * 150);
  }
}

/** Applausi dai telefoni: ogni applauso è una bolla che sale e svanisce (come i cuori nelle live). */
export function useApplause() {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const seq = useRef(0);
  useEffect(preloadApplause, []);

  // ogni tocco è una bolla (si può applaudire a raffica); il suono invece è uno alla volta per
  // persona (vedi PER_PERSON): riparte al primo tocco dopo che è finito
  const push = useCallback((name: string) => {
    playApplause(name);
    const b: Bubble = {
      key: ++seq.current,
      name,
      x: Math.random(),
      drift: (Math.random() - 0.5) * 5,
      dur: 3.6 + Math.random() * 0.4,
      size: 0.85 + Math.random() * 0.35,
    };
    setBubbles((prev) => [...prev, b].slice(-MAX_BUBBLES));
    window.setTimeout(() => setBubbles((prev) => prev.filter((x) => x.key !== b.key)), b.dur * 1000 + 100);
  }, []);

  return { bubbles, push };
}

export function ApplauseLayer({ bubbles }: { bubbles: Bubble[] }) {
  if (!bubbles.length) return null;
  return (
    <div className="applause" aria-hidden>
      {bubbles.map((b) => (
        <div
          key={b.key}
          className="clap"
          style={
            {
              left: `${b.x * 100}%`,
              "--drift": `${b.drift}vw`,
              "--dur": `${b.dur}s`,
              "--size": b.size,
            } as React.CSSProperties
          }
        >
          <Avatar name={b.name} className="clap-avatar" />
          <span className="clap-icon">👏</span>
          <span className="fly-name">{b.name}</span>
        </div>
      ))}
    </div>
  );
}
