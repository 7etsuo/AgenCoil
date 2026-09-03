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
    oscs: OscillatorNode[];
    filter: BiquadFilterNode;
  } | null = null;
  private mood = 0;

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
    if (this.muted) {
      this.stopMusic();
      this.setDanger(0);
      this.setHeartbeat(false);
    } else if (this.ctx) this.startMusic();
    return this.muted;
  }

  /** Eating pitch climbs with a combo of quick eats or close calls. */
  eat(v: number, combo = 0): void {
    // A pentatonic climb with the combo, so a feeding run sounds like a riff.
    const steps = [0, 2, 4, 7, 9, 12, 14, 16, 19];
    const semis = steps[Math.min(combo, steps.length - 1)]!;
    this.blip((520 + v * 30) * Math.pow(2, semis / 12), 0.05, 0.08, "triangle");
  }

  near(combo: number): void {
    this.blip(900 + Math.min(combo, 8) * 60, 0.07, 0.07, "sine");
  }

  private danger: { osc: OscillatorNode; gain: GainNode } | null = null;
  private heart: ReturnType<typeof setInterval> | null = null;

  /** Low rumble while a much bigger snake is close; level 0..1. */
  setDanger(level: number): void {
    if (!this.ctx) return;
    if (this.muted || level <= 0) {
      if (this.danger) {
        this.danger.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
        const d = this.danger;
        this.danger = null;
        setTimeout(() => {
          d.osc.stop();
          d.osc.disconnect();
          d.gain.disconnect();
        }, 600);
      }
      return;
    }
    if (!this.danger) {
      const osc = this.ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 38;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      const filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 120;
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      this.danger = { osc, gain };
    }
    this.danger.gain.gain.setTargetAtTime(0.06 * level, this.ctx.currentTime, 0.15);
  }

  /** A slow heartbeat while boosting on a short snake. */
  setHeartbeat(on: boolean): void {
    if (on && !this.heart && !this.muted && this.ctx) {
      const beat = () => {
        this.blip(70, 0.09, 0.14, "sine");
        setTimeout(() => this.blip(58, 0.09, 0.1, "sine"), 170);
      };
      beat();
      this.heart = setInterval(beat, 900);
    } else if (!on && this.heart) {
      clearInterval(this.heart);
      this.heart = null;
    }
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
    const oscs: OscillatorNode[] = [];
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
      oscs.push(osc);
    }
    filter.connect(master);
    master.connect(ctx.destination);
    const timer = setInterval(() => this.note(master), 2100 + Math.random() * 1600);
    this.music = { master, timer, nodes, oscs, filter };
    this.applyMood();
  }

  /**
   * Three moods that track how big you are: 0 calm and low, 1 brighter and
   * a fourth up, 2 dark and heavy a fourth down. Transitions glide.
   */
  private intensity = 0;

  /** 0..1 with your rank: the pad opens up and brightens as you climb. */
  setIntensity(level: number): void {
    const v = Math.max(0, Math.min(1, level));
    if (Math.abs(v - this.intensity) < 0.08) return;
    this.intensity = v;
    this.applyMood();
  }

  setMood(mood: number): void {
    const m = Math.max(0, Math.min(2, Math.round(mood)));
    if (m === this.mood) return;
    this.mood = m;
    this.applyMood();
  }

  private applyMood(): void {
    const mu = this.music;
    if (!mu || !this.ctx) return;
    const t = this.ctx.currentTime;
    const root = this.mood === 1 ? 73.4 : this.mood === 2 ? 41.2 : 55;
    const mults = [1, 1, 2, 3];
    mu.oscs.forEach((o, i) => o.frequency.setTargetAtTime(root * mults[i]!, t, 1.5));
    const base = this.mood === 1 ? 900 : this.mood === 2 ? 320 : 520;
    mu.filter.frequency.setTargetAtTime(base * (1 + 1.1 * this.intensity), t, 1.5);
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
    const base = this.mood === 1 ? 146.8 : this.mood === 2 ? 82.4 : 110;
    const freq = base * Math.pow(2, semis / 12);
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
