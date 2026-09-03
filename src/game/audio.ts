export class GameAudio {
  private ctx: AudioContext | null = null;
  muted = false;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
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
