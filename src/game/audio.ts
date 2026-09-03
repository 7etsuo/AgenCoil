/**
 * All sound is synthesised: short blips for eating, boosting, kills and
 * death, plus a quiet generative pad that plays while you are in the arena.
 */
const PENTATONIC = [0, 2, 4, 7, 9, 12, 14, 16];

export class GameAudio {
  private ctx: AudioContext | null = null;
  muted = false;
  private music: {
    master: GainNode;
    timer: ReturnType<typeof setInterval>;
    nodes: AudioNode[];
  } | null = null;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.muted) this.stopMusic();
    else if (this.ctx) this.startMusic();
    return this.muted;
  }

  eat(v: number): void {
    this.blip(520 + v * 40, 0.05, 0.08, "triangle");
  }

  boost(): void {
    this.blip(180, 0.04, 0.05, "sawtooth");
  }

  death(): void {
    this.blip(140, 0.18, 0.12, "sine");
  }

  kill(): void {
    this.blip(660, 0.09, 0.09, "triangle");
    setTimeout(() => this.blip(880, 0.12, 0.09, "triangle"), 70);
  }

  /** A slow pad with a drifting filter and the odd soft note. */
  startMusic(): void {
    if (this.muted || !this.ctx || this.music) return;
    const ctx = this.ctx;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.045, ctx.currentTime + 4);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 520;
    filter.Q.value = 0.8;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();
    const nodes: AudioNode[] = [lfo, lfoGain, filter];
    const root = 55;
    for (const [mult, detune] of [
      [1, -6],
      [1, 7],
      [2, 3],
      [3, -4],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = mult === 3 ? "sine" : "sawtooth";
      osc.frequency.value = root * mult;
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = mult === 1 ? 0.5 : mult === 2 ? 0.25 : 0.35;
      osc.connect(g);
      g.connect(filter);
      osc.start();
      nodes.push(osc, g);
    }
    filter.connect(master);
    master.connect(ctx.destination);
    const timer = setInterval(() => this.note(master), 2100 + Math.random() * 1600);
    this.music = { master, timer, nodes };
  }

  stopMusic(): void {
    const m = this.music;
    if (!m || !this.ctx) return;
    this.music = null;
    clearInterval(m.timer);
    const t = this.ctx.currentTime;
    m.master.gain.cancelScheduledValues(t);
    m.master.gain.setValueAtTime(m.master.gain.value, t);
    m.master.gain.linearRampToValueAtTime(0, t + 1.2);
    setTimeout(() => {
      for (const n of m.nodes) {
        if (n instanceof OscillatorNode) n.stop();
        n.disconnect();
      }
      m.master.disconnect();
    }, 1400);
  }

  private note(master: GainNode): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const semis =
      PENTATONIC[(Math.random() * PENTATONIC.length) | 0]! + 12 * (1 + ((Math.random() * 2) | 0));
    const freq = 110 * Math.pow(2, semis / 12);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + 2.4);
  }

  private blip(freq: number, dur: number, gain: number, type: OscillatorType): void {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.55), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g);
    g.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}
