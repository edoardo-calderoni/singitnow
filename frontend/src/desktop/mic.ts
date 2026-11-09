/**
 * Voce dal microfono del PC: altezza della nota cantata in tempo reale (algoritmo YIN).
 * Il microfono non viene mandato alle casse da qui (lo fa Windows con «Ascolta questo dispositivo»,
 * oppure il motore audio di SingITnow con l'autotune).
 */
export class MicPitch {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private buf = new Float32Array(2048);
  private diff = new Float32Array(1024);
  // pulizia della riga: ultime letture, ultima nota data, salti d'ottava di fila
  private hist: { t: number; m: number }[] = [];
  private last: number | null = null;
  private lastAt = 0;
  private octRun = 0;

  /** deviceId: microfono da usare (vuoto = quello predefinito di Windows) */
  async start(deviceId?: string) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // la canzone che esce dalle casse rientra nel microfono (soprattutto la voce originale, anche
        // quella che resta nella base) e "tira" la nota misurata verso quella del cantante: la
        // cancellazione dell'eco la toglie, perché il browser sa esattamente cosa sta suonando
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.buf.length;
    src.connect(this.analyser);
    await this.ctx.resume();
  }

  /** Ritardo tra la voce e il momento in cui la si analizza (s). */
  get latency(): number {
    // finestra di analisi (metà buffer) + ritardo di ingresso stimato + mediana delle letture (~40 ms)
    return this.ctx ? this.buf.length / 2 / this.ctx.sampleRate + (this.ctx.baseLatency || 0) + 0.06 : 0;
  }

  /**
   * Nota cantata adesso (MIDI con decimali), null se silenzio o suono non intonato.
   * Va chiamata una volta per fotogramma. Rispetto alla lettura grezza:
   * - i salti d'ottava improvvisi (l'algoritmo che scambia la seconda armonica per la nota) si
   *   riportano all'ottava della nota precedente; un vero cambio d'ottava passa se dura ~100 ms;
   * - la mediana delle ultime letture toglie i picchi isolati, così una nota tenuta resta piatta;
   * - un buco brevissimo (una lettura persa) tiene l'ultima nota, così la riga non si spezza.
   */
  read(): number | null {
    const now = performance.now();
    let m = this.detect();
    if (m != null && this.last != null && now - this.lastAt < 250) {
      const k = Math.round((m - this.last) / 12);
      if (k !== 0 && Math.abs(m - 12 * k - this.last) < 2) {
        if (++this.octRun < 6) m -= 12 * k;
      } else this.octRun = 0;
    } else this.octRun = 0;
    if (m != null) this.hist.push({ t: now, m });
    while (this.hist.length && this.hist[0].t < now - 80) this.hist.shift();
    if (m == null) {
      if (this.last != null && now - this.lastAt < 120) return this.last;
      this.hist.length = 0;
      return null;
    }
    const sorted = this.hist.map((h) => h.m).sort((a, b) => a - b);
    const out = sorted[sorted.length >> 1];
    this.last = out;
    this.lastAt = now;
    return out;
  }

  /** Lettura grezza (YIN) dell'ultimo pezzetto di voce. */
  private detect(): number | null {
    const an = this.analyser;
    if (!an || !this.ctx) return null;
    const x = this.buf;
    an.getFloatTimeDomainData(x);
    let rms = 0;
    for (let i = 0; i < x.length; i++) rms += x[i] * x[i];
    rms = Math.sqrt(rms / x.length);
    if (rms < 0.004) return null; // ~-48 dBFS: anche le parti cantate piano

    const sr = this.ctx.sampleRate;
    const W = 1024;
    const tauMin = Math.floor(sr / 1000); // fino a ~1000 Hz
    const tauMax = Math.min(Math.floor(sr / 70), x.length - W - 1); // da ~70 Hz
    const d = this.diff;
    // differenza quadratica media normalizzata cumulativa (YIN)
    let running = 0;
    d[0] = 1;
    let found = -1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) {
        const v = x[j] - x[j + tau];
        sum += v * v;
      }
      running += sum;
      d[tau] = running ? (sum * tau) / running : 1;
      if (found < 0 && tau > tauMin && d[tau - 1] < 0.15 && d[tau - 1] <= d[tau]) {
        found = tau - 1;
        break;
      }
    }
    if (found < 0) {
      // nessun minimo sotto soglia (voce un po' soffiata o con la musica sotto): si prende il
      // minimo più profondo, se è comunque chiaro; altrimenti non è una nota
      let best = tauMin + 1;
      for (let tau = tauMin + 1; tau < tauMax; tau++) if (d[tau] < d[best]) best = tau;
      if (d[best] > 0.3) return null;
      // il primo minimo quasi profondo quanto quello: i multipli del periodo darebbero un'ottava sotto
      found = best;
      for (let tau = tauMin + 1; tau < best; tau++) {
        if (d[tau] < d[best] + 0.06 && d[tau] <= d[tau - 1] && d[tau] <= d[tau + 1]) {
          found = tau;
          break;
        }
      }
    }
    // interpolazione parabolica intorno al minimo
    const a = d[found - 1] ?? d[found];
    const b = d[found];
    const c = d[found + 1] ?? d[found];
    const den = a + c - 2 * b;
    const tau = den ? found + (a - c) / (2 * den) : found;
    const f = sr / tau;
    if (f < 70 || f > 1000) return null;
    return 69 + 12 * Math.log2(f / 440);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.ctx = this.stream = this.analyser = null;
  }
}

/** Microfoni che non servono per cantare (webcam, microfoni integrati del portatile, missaggio stereo). */
const NOT_FOR_SINGING = /webcam|camera|\bcam\b|array|matrice|integrat|built-?in|stereo mix|missaggio stereo|what u hear/i;

/**
 * Microfoni con cui si canta: se ce ne sono due collegati restituisce i loro id (il primo è
 * quello predefinito di Windows), altrimenti [""] = solo il microfono predefinito.
 * Va chiamata dopo aver avuto il permesso del microfono (prima i nomi dei dispositivi sono vuoti).
 */
export async function singingMics(): Promise<string[]> {
  const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  // "default" e "communications" sono solo alias di un microfono vero
  const def = all.find((d) => d.deviceId === "default");
  const real = all.filter(
    (d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications" && !NOT_FOR_SINGING.test(d.label),
  );
  if (real.length < 2) return [""];
  real.sort((a, b) => Number(b.groupId === def?.groupId) - Number(a.groupId === def?.groupId));
  return [real[0].deviceId, real[1].deviceId];
}
