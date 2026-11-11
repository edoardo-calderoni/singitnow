import { KaraokeEngine } from "../shared/engine";
import { singingMics } from "./mic";

/** Sotto questa durata (brano fermato subito) la registrazione non si manda al PC. */
export const MIN_RECORD_SECONDS = 45;

/**
 * Registrazione dell'esibizione: microfoni del PC + quello che esce dalle casse (base e voce guida),
 * in un unico file WebM/Opus.
 *
 * I microfoni si aprono qui (anche a Competizione spenta), con la cancellazione dell'eco: la musica
 * delle casse rientra poco nella voce. La base va ritardata di quanto il suono impiega a uscire dalle
 * casse e a rientrare nel microfono, altrimenti nella registrazione la voce arriva in ritardo.
 */
export class PerformanceRecorder {
  private streams: MediaStream[] = [];
  private nodes: AudioNode[] = [];
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0; // performance.now() all'avvio
  private pausedAt = 0;
  private pausedFor = 0;
  private delay = 0; // ritardo della base nella registrazione (vedi start)
  /** [secondi della registrazione, secondi del brano] all'avvio e dopo ogni salto: il video con il
   *  testo li usa per restare a tempo. */
  readonly marks: [number, number][] = [];

  constructor(private engine: KaraokeEngine) {}

  async start() {
    const ctx = this.engine.context;
    const first = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
    this.streams = [first];
    // due microfoni collegati (duetto): si registrano tutti e due
    const ids = await singingMics().catch(() => [""]);
    if (ids.length > 1) {
      first.getTracks().forEach((t) => t.stop());
      this.streams = await Promise.all(ids.map((id) => navigator.mediaDevices.getUserMedia({ audio: micConstraints(id) })));
    }
    const dest = ctx.createMediaStreamDestination();
    const delay = ctx.createDelay(1);
    delay.delayTime.value = Math.min(0.9, this.engine.outputLatency + 0.03);
    this.delay = delay.delayTime.value;
    const music = ctx.createGain();
    music.gain.value = 0.8; // la voce deve sentirsi sopra la base
    this.engine.tap(delay);
    delay.connect(music).connect(dest);
    this.nodes = [delay, music];
    for (const s of this.streams) {
      const src = ctx.createMediaStreamSource(s);
      const voice = ctx.createGain();
      voice.gain.value = 1.6;
      src.connect(voice).connect(dest);
      this.nodes.push(src, voice);
    }
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );
    this.recorder = new MediaRecorder(dest.stream, { mimeType, audioBitsPerSecond: 128000 });
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start(5000); // a pezzi: un brano lungo non resta tutto in un unico buffer
    this.startedAt = performance.now();
  }

  pause() {
    if (this.recorder?.state === "recording") {
      this.recorder.pause();
      this.pausedAt = performance.now();
    }
  }

  resume() {
    if (this.recorder?.state === "paused") {
      this.recorder.resume();
      this.pausedFor += performance.now() - this.pausedAt;
    }
  }

  /**
   * Da chiamare di continuo con la posizione del brano: annota dove la registrazione e il brano
   * smettono di andare di pari passo (avvio, salto avanti o indietro).
   */
  track(songTime: number) {
    if (this.recorder?.state !== "recording") return;
    const rec = this.seconds;
    const song = songTime - this.delay; // la base entra nella registrazione con questo ritardo
    const last = this.marks[this.marks.length - 1];
    if (!last || Math.abs(song - (last[1] + rec - last[0])) > 0.3) this.marks.push([rec, song]);
  }

  /** Secondi registrati (pause escluse). */
  get seconds(): number {
    if (!this.startedAt) return 0;
    const paused = this.recorder?.state === "paused" ? performance.now() - this.pausedAt : 0;
    return (performance.now() - this.startedAt - this.pausedFor - paused) / 1000;
  }

  /** Ferma tutto e restituisce il file (null se non è partita). */
  async stop(): Promise<Blob | null> {
    const rec = this.recorder;
    let blob: Blob | null = null;
    if (rec && rec.state !== "inactive") {
      blob = await new Promise<Blob>((resolve) => {
        rec.onstop = () => resolve(new Blob(this.chunks, { type: rec.mimeType || "audio/webm" }));
        rec.stop();
      });
    }
    this.release();
    return blob;
  }

  /** Ferma tutto senza tenere niente (registrazione spenta o brano chiuso prima del tempo). */
  cancel() {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.ondataavailable = null;
      this.recorder.stop();
    }
    this.release();
  }

  private release() {
    this.nodes.forEach((n) => n.disconnect());
    this.nodes = [];
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.streams = [];
    this.recorder = null;
    this.chunks = [];
  }
}

function micConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: true, // la base che esce dalle casse non si registra due volte
    noiseSuppression: false,
    autoGainControl: false,
  };
}
