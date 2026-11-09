import { useEffect, useRef, useState } from "react";
import { MicPitch } from "./mic";
import { newScore, PitchScore, scoreOf, track } from "./performance";

/** [inizio, fine, nota MIDI] oppure [inizio, fine, nota MIDI, 1] se la nota è incerta (non conta nel punteggio) */
export type Note = [number, number, number] | [number, number, number, number];
const uncertain = (n: Note) => n.length > 3 && !!n[3];

const PAST = 2; // secondi visibili prima della linea "adesso"
const FUTURE = 6; // secondi visibili dopo
const NOW_X = PAST / (PAST + FUTURE);

/**
 * Colori della voce per [intonato, vicino, stonato, fuori dalle note].
 * Con un solo microfono i colori di sempre; con due, ognuno ha il suo colore.
 */
const SOLO = ["#ff3d9a", "#ffb347", "rgb(130,160,255)", "rgb(120,120,140)"];
// con due microfoni: il rosso e il blu, come i microfoni veri
const DUO = [
  ["#ff3b3b", "rgb(210,85,85)", "rgb(150,80,80)", "rgb(125,100,100)"],
  ["#3b8bff", "rgb(80,130,210)", "rgb(70,100,150)", "rgb(95,110,130)"],
];

interface Props {
  notes: Note[];
  mics: MicPitch[];
  /** nome mostrato sopra ogni punteggio (con due microfoni) */
  labels: string[];
  micError: string;
  /** posizione del brano e ritardo dell'uscita audio (s) */
  clock: () => { t: number; playing: boolean; outLatency: number };
  scoreRef: React.MutableRefObject<PitchScore[]>;
  /** semitoni di cui è stata spostata la tonalità della base (la voce va riportata all'originale) */
  keyShift?: React.MutableRefObject<number>;
}

/**
 * Barre delle note che scorrono verso la linea "adesso" e, sopra, la voce di chi canta
 * (una linea per microfono), colorata se è intonata. Disegnata su canvas a ogni fotogramma.
 */
export function PitchBar({ notes, mics, labels, micError, clock, scoreRef, keyShift }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const bar = useRef<HTMLDivElement>(null);

  // la fascia parte sempre sotto foto e titolo in alto (che crescono con lo schermo)
  useEffect(() => {
    const head = document.querySelector<HTMLElement>(".player-top .now-singer");
    const el = bar.current;
    if (!head || !el) return;
    const place = () => {
      const bottom = head.getBoundingClientRect().bottom;
      el.style.top = `${Math.round(bottom + Math.max(12, window.innerHeight * 0.015))}px`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(head);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, []);
  const [scores, setScores] = useState<number[]>([]);
  const [singing, setSinging] = useState<boolean[]>([]);

  useEffect(() => {
    const cv = canvas.current!;
    const g = cv.getContext("2d")!;
    // intervallo di note mostrato: quello del brano (senza le note più estreme)
    const pitches = notes.map((n) => n[2]).sort((a, b) => a - b);
    const lo = Math.floor((pitches[Math.floor(pitches.length * 0.03)] ?? 55) - 2);
    const hi = Math.ceil((pitches[Math.floor(pitches.length * 0.97)] ?? 72) + 2);
    const span = Math.max(hi - lo, 12);
    // solo le note riconosciute con sicurezza contano nel punteggio
    const total = notes.reduce((a, n) => a + (uncertain(n) ? 0 : n[1] - n[0]), 0);
    const fresh = () => mics.map(() => newScore(total));
    scoreRef.current = fresh();
    const colors = mics.length > 1 ? DUO : [SOLO];

    let raf = 0;
    let lastT = -1;
    let lastFrame = performance.now();
    let idx = 0; // prima nota non ancora finita
    let lastUi = 0;
    // scia di ogni microfono; q: 2 intonato, 1 vicino, 0 stonato, -1 fuori dalle note
    const trails: { t: number; m: number; q: number }[][] = mics.map(() => []);
    const voiceSeen = mics.map(() => 0);
    // ottava di chi canta rispetto alla melodia (chi canta un'ottava sotto si vede comunque sulle
    // barre): stimata sugli ultimi secondi e non istante per istante, così la riga mostra davvero la
    // nota cantata (una nota tenuta resta piatta) invece di "saltare" d'ottava per inseguire la melodia
    const octave = mics.map(() => ({ shift: 0, hist: [] as { t: number; d: number }[] }));
    const OCT_WINDOW = 4; // secondi

    const noteAt = (t: number) => {
      while (idx < notes.length && notes[idx][1] < t) idx++;
      while (idx > 0 && notes[idx - 1][1] >= t) idx--;
      const n = notes[idx];
      return n && n[0] <= t ? n : null;
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      const dt = Math.min((now - lastFrame) / 1000, 0.1);
      lastFrame = now;
      const { t, playing, outLatency } = clock();
      if (lastT >= 0 && t < lastT - 1) {
        // si è tornati indietro (ricomincia o salto): punteggi e scie ripartono
        scoreRef.current = fresh();
        trails.forEach((tr) => (tr.length = 0));
      }
      lastT = t;

      // la voce che arriva adesso risponde a ciò che si sentiva qualche istante fa
      const tv = t - outLatency - (mics[0]?.latency ?? 0);
      const ref = noteAt(tv);
      mics.forEach((mic, i) => {
        const trail = trails[i];
        const heard = playing ? mic.read() : null;
        // base trasposta: chi canta segue la nuova tonalità, le barre restano quelle del brano originale
        const sungMidi = heard == null ? null : heard - (keyShift?.current ?? 0);
        if (sungMidi != null) voiceSeen[i] = now;
        const oct = octave[i];
        if (playing && ref && sungMidi != null) {
          oct.hist.push({ t: tv, d: sungMidi - ref[2] });
          while (oct.hist.length && oct.hist[0].t < tv - OCT_WINDOW) oct.hist.shift();
          const ds = oct.hist.map((h) => h.d).sort((a, b) => a - b);
          oct.shift = 12 * Math.round(ds[ds.length >> 1] / 12);
        }
        if (playing) {
          // scarto dalla nota da cantare: per il voto un'ottava sopra o sotto va bene lo stesso
          let d: number | null = null;
          if (ref && sungMidi != null) {
            d = sungMidi - ref[2];
            d -= 12 * Math.round(d / 12);
          }
          // statistiche nota per nota (voto e pannello dei risultati)
          track(scoreRef.current[i], ref, idx, !!ref && !uncertain(ref), tv, dt, d, heard);
          if (sungMidi != null) {
            // senza nota da cantare la voce si vede (nella sua ottava abituale), ma non conta
            const q = d == null ? -1 : Math.abs(d) <= 1 ? 2 : Math.abs(d) <= 2 ? 1 : 0;
            trail.push({ t: tv, m: sungMidi - oct.shift, q });
          }
        }
        while (trail.length && trail[0].t < tv - PAST - 0.5) trail.shift();
      });

      // ---------------------------------------------------------------- disegno
      const W = cv.clientWidth;
      const H = cv.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const pad = 18; // le barre più spesse non devono uscire dalla fascia
      const row = (H - pad * 2) / span;
      const bh = Math.max(14, Math.min(row * 1.4, 26)); // spessore delle barre delle note
      const x = (time: number) => ((time - (tv - PAST)) / (PAST + FUTURE)) * W;
      const y = (m: number) => pad + (hi - Math.max(lo, Math.min(hi, m))) * row;

      // righe orizzontali di riferimento (ogni tot semitoni, così restano ben distanziate)
      const step = Math.max(1, Math.ceil(20 / row));
      g.strokeStyle = "rgba(255,255,255,0.09)";
      g.lineWidth = 1;
      g.beginPath();
      for (let m = hi; m >= lo; m -= step) {
        const yy = Math.round(y(m)) + 0.5;
        g.moveTo(0, yy);
        g.lineTo(W, yy);
      }
      g.stroke();

      // note da cantare
      for (let i = Math.max(0, idx - 30); i < notes.length; i++) {
        const [a, b, m] = notes[i];
        if (a > tv + FUTURE) break;
        if (b < tv - PAST) continue;
        const x0 = x(a);
        const x1 = Math.max(x(b), x0 + 4);
        const yy = y(Math.round(m)) - bh / 2;
        const active = a <= tv && tv <= b;
        g.fillStyle = active ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.22)";
        g.strokeStyle = "rgba(255,255,255,0.5)";
        g.lineWidth = 1;
        g.beginPath();
        g.roundRect(x0, yy, x1 - x0, bh, bh / 2);
        g.fill();
        g.stroke();
      }

      // voce di chi canta (con due microfoni le linee sono un po' più sottili e affiancate)
      g.lineCap = "round";
      const thin = mics.length > 1 ? 0.75 : 1;
      trails.forEach((trail, k) => {
        const col = colors[k] ?? colors[0];
        const shift = mics.length > 1 ? (k === 0 ? -bh * 0.18 : bh * 0.18) : 0;
        for (let i = 1; i < trail.length; i++) {
          const p = trail[i - 1];
          const c = trail[i];
          if (c.t - p.t > 0.12) continue;
          const good = c.q === 2;
          g.strokeStyle = good ? col[0] : c.q === 1 ? col[1] : c.q === 0 ? col[2] : col[3];
          g.lineWidth = (good ? bh : bh * 0.75) * thin; // spessore della voce
          g.shadowColor = good ? col[0] : "transparent";
          g.shadowBlur = good ? 18 : 0;
          g.beginPath();
          g.moveTo(x(p.t), y(p.m) + shift);
          g.lineTo(x(c.t), y(c.m) + shift);
          g.stroke();
        }
      });
      g.shadowBlur = 0;

      // linea "adesso"
      const nx = NOW_X * W;
      g.strokeStyle = "rgba(255,255,255,0.8)";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(nx, 4);
      g.lineTo(nx, H - 4);
      g.stroke();

      if (now - lastUi > 250) {
        lastUi = now;
        setScores(scoreRef.current.map(scoreOf));
        setSinging(voiceSeen.map((v) => now - v < 1500));
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [notes, mics, clock, scoreRef, keyShift]);

  const duo = mics.length > 1;
  return (
    <>
      <div className="pitch-bar" ref={bar}>
        <canvas ref={canvas} />
      </div>
      {/* punteggio grande, al centro in alto sullo schermo (uno per microfono) */}
      <div className={`pitch-score ${duo ? "duo" : ""}`}>
        {micError ? (
          <span className="pitch-warn">{micError}</span>
        ) : (
          (mics.length ? mics : [null]).map((_, i) => (
            <div className={`pitch-one p${i + 1}`} key={i}>
              <div className="pitch-label">
                <span className={`pitch-mic ${singing[i] ? "on" : ""}`} />
                <span className="ellipsis">{duo ? labels[i] : "Intonazione"}</span>
              </div>
              <b className={duo ? "" : "grad-text"}>{scores[i] ?? 0}</b>
            </div>
          ))
        )}
      </div>
    </>
  );
}
