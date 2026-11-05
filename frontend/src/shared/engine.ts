/**
 * Motore karaoke: riproduce base e voce originale come due tracce Web Audio
 * avviate sullo stesso istante (sincronia al campione), con volumi indipendenti.
 * Il video (muto) segue l'orologio audio.
 */
export class KaraokeEngine {
  private ctx = new AudioContext({ latencyHint: "playback" });
  private music = this.ctx.createGain();
  private vocals = this.ctx.createGain();
  private master = this.ctx.createGain(); // volume generale (base + voce)
  private buffers: { music?: AudioBuffer; vocals?: AudioBuffer } = {};
  private sources: AudioBufferSourceNode[] = [];
  private startedAt = 0; // ctx.currentTime corrispondente a offset 0
  private offset = 0; // posizione quando in pausa
  private raf = 0;
  private endTimer: number | undefined;
  playing = false;
  duration = 0;
  onEnded?: () => void;

  constructor(private video: HTMLVideoElement) {
    this.music.connect(this.master);
    this.vocals.connect(this.master);
    this.master.connect(this.ctx.destination);
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

  get currentTime(): number {
    if (!this.playing) return this.offset;
    return Math.min(this.ctx.currentTime - this.startedAt, this.duration);
  }

  setVocalVolume(v: number) {
    this.vocals.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }
  /** Volume generale: abbassa o alza insieme base musicale e voce guida. */
  setMasterVolume(v: number) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  async play() {
    if (this.playing || !this.buffers.music) return;
    await this.ctx.resume();
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    const when = this.ctx.currentTime + 0.08;
    this.sources = (["music", "vocals"] as const).map((k) => {
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffers[k]!;
      src.connect(k === "music" ? this.music : this.vocals);
      src.start(when, this.offset);
      return src;
    });
    this.startedAt = when - this.offset;
    this.playing = true;
    // Fine brano: non affidarsi solo ai fotogrammi (sospesi se la finestra è ridotta a icona).
    this.sources[0]!.onended = () => this.checkEnd();
    window.clearTimeout(this.endTimer);
    this.endTimer = window.setTimeout(() => this.checkEnd(), (this.duration - this.offset + 0.3) * 1000);
    this.video.currentTime = this.offset;
    this.video.play().catch(() => {});
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
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
    if (was) this.play();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.stopSources();
    this.playing = false;
    this.ctx.close();
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
    const t = this.currentTime;
    if (t >= this.duration - 0.02) {
      this.finish();
      return;
    }
    const v = this.video;
    if (v.readyState >= 2 && t < v.duration) {
      const drift = v.currentTime - t;
      if (Math.abs(drift) > 0.3) {
        v.currentTime = t;
        v.playbackRate = 1;
      } else {
        // correzione dolce per piccole derive
        v.playbackRate = Math.abs(drift) > 0.04 ? 1 - Math.sign(drift) * 0.05 : 1;
      }
      if (v.paused) v.play().catch(() => {});
    }
    this.raf = requestAnimationFrame(this.tick);
  }
}
