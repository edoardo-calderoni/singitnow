/**
 * Motore karaoke: riproduce base e voce originale come due tracce Web Audio
 * avviate sullo stesso istante (sincronia al campione), con volumi indipendenti.
 * Il video (muto) segue l'orologio audio.
 *
 * Tutti i brani usano lo stesso AudioContext: due brani (il mix in battuta della modalità DJ)
 * condividono così lo stesso orologio e uno può partire esattamente su un battito dell'altro.
 * La velocità si può cambiare (playbackRate, come il pitch di un giradischi: cambia anche
 * l'intonazione) senza perdere la posizione.
 */
let sharedCtx: AudioContext | null = null;
function audioContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === "closed") sharedCtx = new AudioContext({ latencyHint: "playback" });
  return sharedCtx;
}

/** Punti di una curva di volume: [istante dell'AudioContext, valore] (rampe lineari fra l'uno e l'altro). */
export type Envelope = [number, number][];

export class KaraokeEngine {
  private ctx = audioContext();
  private music = this.ctx.createGain();
  private vocals = this.ctx.createGain();
  private master = this.ctx.createGain(); // volume generale (base + voce)
  // filtro dei bassi (sotto ~200 Hz): nel mix in battuta si «scambiano» i bassi fra i due brani
  private bass = this.ctx.createBiquadFilter();
  private buffers: { music?: AudioBuffer; vocals?: AudioBuffer } = {};
  private sources: AudioBufferSourceNode[] = [];
  // posizione nel brano = anchorPos + (ctx.currentTime - anchorCtx) * rate
  private anchorCtx = 0;
  private anchorPos = 0;
  private rate = 1;
  private offset = 0; // posizione quando in pausa
  private raf = 0;
  private endTimer: number | undefined;
  private rampTimer: number | undefined;
  private destroyed = false;
  playing = false;
  duration = 0;
  onEnded?: () => void;

  constructor(private video: HTMLVideoElement) {
    this.bass.type = "lowshelf";
    this.bass.frequency.value = 200;
    this.bass.gain.value = 0;
    this.music.connect(this.master);
    this.vocals.connect(this.master);
    this.master.connect(this.bass);
    this.bass.connect(this.ctx.destination);
    video.muted = true;
    this.tick = this.tick.bind(this);
  }

  async load(musicUrl: string, vocalsUrl: string, onProgress?: (p: number) => void) {
    let done = 0;
    const fetchDecode = async (url: string) => {
      const buf = await (await fetch(url)).arrayBuffer();
      onProgress?.(++done / 4);
      const audio = await this.ctx.decodeAudioData(buf);
      onProgress?.(++done / 4);
      return audio;
    };
    const [music, vocals] = await Promise.all([fetchDecode(musicUrl), fetchDecode(vocalsUrl)]);
    this.buffers = { music, vocals };
    this.duration = Math.max(music.duration, vocals.duration);
  }

  /**
   * Sostituisce base e voce (es. la stessa canzone in un'altra tonalità) senza perdere la posizione:
   * le nuove tracce vengono scaricate mentre suonano ancora le vecchie, poi lo scambio è istantaneo.
   */
  async swap(musicUrl: string, vocalsUrl: string) {
    const fetchDecode = async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `Errore ${res.status}`);
      return this.ctx.decodeAudioData(await res.arrayBuffer());
    };
    const [music, vocals] = await Promise.all([fetchDecode(musicUrl), fetchDecode(vocalsUrl)]);
    if (this.destroyed) return;
    const was = this.playing;
    if (was) {
      // play() fa ripartire l'audio fra 80 ms: si riprende da lì, così l'orologio del brano non torna indietro
      this.offset = Math.min(this.currentTime + 0.08 * this.rate, this.duration);
      this.stopSources();
      this.playing = false;
    }
    this.buffers = { music, vocals };
    if (was) await this.play(true);
  }

  /** Ritardo tra l'istante del brano e il suono che esce dalle casse (s). */
  get outputLatency(): number {
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
  }

  /** Orologio dell'AudioContext (condiviso da tutti i brani). */
  get now(): number {
    return this.ctx.currentTime;
  }

  get currentTime(): number {
    if (!this.playing) return this.offset;
    const now = this.ctx.currentTime;
    if (now < this.anchorCtx) return this.anchorPos; // avvio programmato non ancora arrivato
    return Math.min(this.anchorPos + (now - this.anchorCtx) * this.rate, this.duration);
  }

  /** Istante dell'AudioContext in cui suonerà la posizione `pos` del brano (alla velocità attuale). */
  timeAt(pos: number): number {
    if (!this.playing) return this.ctx.currentTime + (pos - this.offset) / this.rate;
    return this.anchorCtx + (pos - this.anchorPos) / this.rate;
  }

  get speed(): number {
    return this.rate;
  }

  setVocalVolume(v: number) {
    this.vocals.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }
  /** Volume generale: abbassa o alza insieme base musicale e voce guida (interrompe una dissolvenza). */
  setMasterVolume(v: number) {
    const g = this.master.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(v, now, 0.03);
  }
  /** Dissolvenza lineare del volume generale fino a `to` in `seconds` (0 = subito). */
  fadeMaster(to: number, seconds: number) {
    const now = this.ctx.currentTime;
    this.envelope("master", seconds <= 0 ? [[now, to]] : [[now + seconds, to]]);
  }
  /**
   * Curva programmata sul volume generale o sui bassi (in dB): da adesso si va per rampe lineari
   * da un punto al successivo. Usata dal mix in battuta.
   */
  envelope(target: "master" | "bass", points: Envelope) {
    const p = target === "master" ? this.master.gain : this.bass.gain;
    const now = this.ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    for (const [t, v] of points) {
      if (t <= now) p.setValueAtTime(v, now);
      else p.linearRampToValueAtTime(v, t);
    }
  }

  async play(keepVideo = false) {
    if (this.playing || !this.buffers.music) return;
    await this.ctx.resume();
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    this.start(this.ctx.currentTime + 0.08, this.offset, keepVideo);
  }

  /**
   * Fa partire il brano dalla posizione `pos` esattamente all'istante `when` dell'AudioContext,
   * alla velocità `rate` (mix in battuta: l'attacco cade su un battito dell'altro brano).
   */
  async playAt(when: number, pos: number, rate = 1) {
    if (!this.buffers.music) return;
    await this.ctx.resume();
    if (this.playing) this.stopSources();
    this.rate = rate;
    this.offset = Math.max(0, Math.min(pos, this.duration));
    this.video.pause();
    this.video.currentTime = this.offset;
    this.start(Math.max(when, this.ctx.currentTime + 0.02), this.offset, true);
  }

  private start(when: number, pos: number, keepVideo: boolean) {
    this.sources = (["music", "vocals"] as const).map((k) => {
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffers[k]!;
      src.playbackRate.value = this.rate;
      src.connect(k === "music" ? this.music : this.vocals);
      src.start(when, pos);
      return src;
    });
    this.anchorCtx = when;
    this.anchorPos = pos;
    this.playing = true;
    // Fine brano: non affidarsi solo ai fotogrammi (sospesi se la finestra è ridotta a icona).
    this.sources[0]!.onended = () => this.checkEnd();
    this.armEndTimer();
    if (!keepVideo) this.video.currentTime = pos; // cambio di tonalità: il video va avanti da solo
    if (when - this.ctx.currentTime < 0.15) this.video.play().catch(() => {});
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  }

  private armEndTimer() {
    window.clearTimeout(this.endTimer);
    const left = Math.max(0, this.anchorCtx - this.ctx.currentTime) + (this.duration - this.currentTime) / this.rate;
    this.endTimer = window.setTimeout(() => this.checkEnd(), (left + 0.3) * 1000);
  }

  /** Cambia la velocità senza perdere la posizione (1 = originale). */
  setRate(r: number) {
    if (r === this.rate) return;
    if (this.playing) {
      const now = this.ctx.currentTime;
      if (now >= this.anchorCtx) {
        this.anchorPos = this.currentTime;
        this.anchorCtx = now;
      }
      for (const s of this.sources) s.playbackRate.setValueAtTime(r, Math.max(now, this.anchorCtx));
    }
    this.rate = r;
    if (this.playing) this.armEndTimer();
  }

  /** Riporta gradualmente la velocità a `to` in `seconds` (a piccoli passi, impercettibili). */
  rampRate(to: number, seconds: number) {
    window.clearInterval(this.rampTimer);
    const from = this.rate;
    const t0 = performance.now();
    this.rampTimer = window.setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / (seconds * 1000));
      this.setRate(from + (to - from) * k);
      if (k >= 1) window.clearInterval(this.rampTimer);
    }, 100);
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.currentTime;
    this.stopSources();
    this.playing = false;
    this.video.pause();
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  seek(t: number) {
    const was = this.playing;
    if (was) {
      this.stopSources();
      this.playing = false;
    }
    this.offset = Math.max(0, Math.min(t, this.duration));
    this.video.currentTime = this.offset;
    if (!was) return;
    // salto fino alla fine (es. freccia → ripetuta): il brano è finito e si passa al successivo,
    // invece di ripartire da capo (play() dalla fine ricomincia dall'inizio)
    if (this.offset >= this.duration - 0.3) {
      this.offset = this.duration;
      this.video.pause();
      this.onEnded?.();
      return;
    }
    this.play();
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.clearInterval(this.rampTimer);
    this.stopSources();
    this.playing = false;
    // l'AudioContext è condiviso: si staccano solo i nodi di questo brano
    this.bass.disconnect();
    this.master.disconnect();
  }

  private checkEnd() {
    if (this.playing && this.currentTime >= this.duration - 0.3) this.finish();
  }

  private finish() {
    window.clearTimeout(this.endTimer);
    this.pause();
    this.offset = this.duration;
    this.onEnded?.();
  }

  private stopSources() {
    window.clearTimeout(this.endTimer);
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* già fermato */
      }
    }
    this.sources = [];
  }

  /** Mantiene il video agganciato all'audio. */
  private tick() {
    if (!this.playing) return;
    const v = this.video;
    if (this.ctx.currentTime < this.anchorCtx) {
      // avvio programmato (mix): il video aspetta fermo sul primo fotogramma
      if (!v.paused) v.pause();
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    const t = this.currentTime;
    if (t >= this.duration - 0.02) {
      this.finish();
      return;
    }
    if (v.readyState >= 2 && t < v.duration) {
      const drift = v.currentTime - t;
      if (Math.abs(drift) > 0.3) {
        v.currentTime = t;
        v.playbackRate = this.rate;
      } else {
        // correzione dolce per piccole derive (alla velocità attuale del brano)
        v.playbackRate = this.rate * (Math.abs(drift) > 0.04 ? 1 - Math.sign(drift) * 0.05 : 1);
      }
      if (v.paused) v.play().catch(() => {});
    }
    this.raf = requestAnimationFrame(this.tick);
  }
}
