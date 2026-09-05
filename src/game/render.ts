import {
  LANDMARKS,
  WISP_REACH,
  type SkinStyle,
  ARENA_RADIUS,
  FOOD_COLORS,
  SKINS,
  bandsOf,
  fillOf,
  type Camera,
  type Floater,
  type Particle,
  type Phase,
  type Snake,
  type Vec,
  clamp,
  dist2,
  lengthOf,
  radiusOf,
  spacingOf,
  zoomOf,
} from "./model";
import { pathLength, type World } from "./world";
import { LEAGUES, LEAGUE_COLORS, LEAGUE_SHAPES } from "./challenges";
import { crestPath, drawCrest } from "./crest";

const HEX = 44;
const SPRITE = 64;

/** A promotion in progress on a snake: the tier reached and when (performance.now()). */
export interface Promotion {
  tier: number;
  at: number;
}

/** A minimap mark beyond the plain dot: the arena's top three, a bounty carrier, a high-tier player. */
export interface MapMark {
  x: number;
  y: number;
  kind: "top" | "bounty" | "tier";
  /** For "tier": 4 Platinum or 5 Diamond, drawn in the tier's colour. */
  tier?: number;
}

interface Sprite {
  canvas: HTMLCanvasElement;
  size: number;
}

export class Renderer {
  private stars: Vec[] = [];
  private foodSprites: Sprite[] = [];
  private segmentSprites = new Map<string, Sprite>();
  private hexTile: HTMLCanvasElement | null = null;
  private hexPattern: CanvasPattern | null = null;
  private nebula: HTMLCanvasElement | null = null;
  private nebulaPattern: CanvasPattern | null = null;
  private vignette: { w: number; h: number; grd: CanvasGradient } | null = null;
  private time = 0;

  constructor() {
    for (let i = 0; i < 260; i++) {
      const p = {
        x: (Math.random() * 2 - 1) * ARENA_RADIUS,
        y: (Math.random() * 2 - 1) * ARENA_RADIUS,
      };
      if (p.x * p.x + p.y * p.y < ARENA_RADIUS * ARENA_RADIUS) this.stars.push(p);
    }
    this.foodSprites = FOOD_COLORS.map((c) => makeFoodSprite(c));
    this.hexTile = makeHexTile();
    this.nebula = makeNebula();
  }

  stepFx(dt: number, particles: Particle[], floaters: Floater[], cam: Camera): void {
    this.time += dt;
    cam.trauma = Math.max(0, cam.trauma - dt * 1.8);
    // Compact in place: a death burst retires hundreds of particles in the
    // same few frames, and a splice per particle made that quadratic.
    let keep = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]!;
      p.life -= dt;
      if (p.life <= 0) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      p.vy *= 0.96;
      particles[keep++] = p;
    }
    particles.length = keep;
    keep = 0;
    for (let i = 0; i < floaters.length; i++) {
      const f = floaters[i]!;
      f.life -= dt;
      if (f.life <= 0) continue;
      f.y -= 28 * dt;
      floaters[keep++] = f;
    }
    floaters.length = keep;
  }

  draw(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    dpr: number,
    cam: Camera,
    world: World,
    particles: Particle[],
    floaters: Floater[],
    localId: string | null,
    phase: Phase,
    aim: Vec | null,
    insets: { top: number; bottom: number } = { top: 0, bottom: 0 },
    event: Vec | null = null,
    ghost: { x: number; y: number; best: number } | null = null,
    emotes: Map<string, { id: number; until: number }> | null = null,
    wisp: { x: number; y: number; angle: number; trail: Vec[] } | null = null,
    ranks: ReadonlyMap<string, number> | null = null,
    marks: readonly MapMark[] = [],
    promos: ReadonlyMap<string, Promotion> | null = null,
  ): void {
    this.promos = promos;
    const shake = cam.trauma * cam.trauma;
    const ox = (Math.random() * 2 - 1) * shake * 14;
    const oy = (Math.random() * 2 - 1) * shake * 14;
    const z = cam.z;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#05070c";
    ctx.fillRect(0, 0, w, h);
    this.drawDeepSpace(ctx, w, h, dpr, cam);

    ctx.setTransform(
      z * dpr,
      0,
      0,
      z * dpr,
      w / 2 - (cam.x + ox) * z * dpr,
      h / 2 - (cam.y + oy) * z * dpr,
    );

    const viewW = w / dpr / z;
    const viewH = h / dpr / z;
    const x0 = cam.x + ox - viewW / 2 - 60;
    const y0 = cam.y + oy - viewH / 2 - 60;
    const x1 = cam.x + ox + viewW / 2 + 60;
    const y1 = cam.y + oy + viewH / 2 + 60;

    this.drawArena(ctx, cam, x0, y0, x1, y1);
    this.drawLandmarks(ctx, x0, y0, x1, y1, z);
    this.drawFood(ctx, world, x0, y0, x1, y1, z);
    this.drawParticles(ctx, particles);
    if (ghost && ghost.x >= x0 && ghost.x <= x1 && ghost.y >= y0 && ghost.y <= y1) {
      this.drawGhost(ctx, ghost, z);
    }

    const snakes = world.snakes;
    const ordered = snakes.slice().sort((a, b) => a.mass - b.mass);
    const view = Math.hypot(viewW, viewH) / 2 + 80;
    for (const s of ordered) {
      this.drawSnake(ctx, s, s.id === localId ? aim : null, cam, view, x0, y0, x1, y1, z);
    }
    // Boost squash marks are dropped when a snake stops boosting; one that
    // died mid-boost never does, so the map is pruned once it outgrows the arena.
    if (this.boostSince.size > snakes.length + 16) {
      const live = new Set(snakes.map((s) => s.id));
      for (const id of this.boostSince.keys()) if (!live.has(id)) this.boostSince.delete(id);
    }
    if (phase === "play" && aim) this.drawAim(ctx, aim, z);

    this.drawFloaters(ctx, floaters, z);

    if (emotes && emotes.size) this.drawEmotes(ctx, snakes, emotes, z);
    if (wisp) this.drawWisp(ctx, wisp, z);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawVignette(ctx, w, h, localId ? snakes.find((s) => s.id === localId) : undefined);
    this.drawNames(ctx, snakes, cam, w, h, dpr, z, ox, oy, ranks);
    this.drawMinimap(ctx, snakes, localId, w, h, dpr, phase, insets, event, ghost, wisp, marks);
  }

  /**
   * Two parallax layers behind the arena: a slow, seamless nebula wash and a
   * field of distant stars. Both are repeating patterns shifted by a fraction
   * of the camera position, so the world reads as deep rather than flat.
   */
  private drawDeepSpace(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    dpr: number,
    cam: Camera,
  ): void {
    if (!this.nebulaPattern && this.nebula) {
      this.nebulaPattern = ctx.createPattern(this.nebula, "repeat");
    }
    // One pattern fill per frame: the star field is baked into the nebula
    // tile, so a phone pays for a single full-screen pass.
    const layers: [CanvasPattern | null, number, number][] = [[this.nebulaPattern, 0.08, 1.2]];
    for (const [pat, parallax, scale] of layers) {
      if (!pat) continue;
      const k = dpr * scale;
      const ox = -cam.x * parallax * dpr;
      const oy = -cam.y * parallax * dpr;
      ctx.setTransform(k, 0, 0, k, ox, oy);
      ctx.fillStyle = pat;
      ctx.fillRect(-ox / k, -oy / k, w / k, h / k);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Darkened corners, and a tint of your own colour at the edges while boosting. */
  private drawVignette(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    me: Snake | undefined,
  ): void {
    if (!this.vignette || this.vignette.w !== w || this.vignette.h !== h) {
      const grd = ctx.createRadialGradient(
        w / 2,
        h / 2,
        Math.min(w, h) * 0.42,
        w / 2,
        h / 2,
        Math.max(w, h) * 0.78,
      );
      grd.addColorStop(0, "rgba(0,0,0,0)");
      grd.addColorStop(1, "rgba(0,0,0,0.5)");
      this.vignette = { w, h, grd };
    }
    ctx.fillStyle = this.vignette.grd;
    ctx.fillRect(0, 0, w, h);
    if (me && me.boosting && me.alive) {
      const [r, g, b] = hexRgb(bandsOf(me)[0]!);
      const pulse = 0.1 + Math.sin(this.time * 14) * 0.03;
      const grd = ctx.createRadialGradient(
        w / 2,
        h / 2,
        Math.min(w, h) * 0.38,
        w / 2,
        h / 2,
        Math.max(w, h) * 0.7,
      );
      grd.addColorStop(0, `rgba(${r},${g},${b},0)`);
      grd.addColorStop(1, `rgba(${r},${g},${b},${pulse})`);
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, w, h);
    }
  }

  private drawEmotes(
    ctx: CanvasRenderingContext2D,
    snakes: Snake[],
    emotes: Map<string, { id: number; until: number }>,
    z: number,
  ): void {
    const glyphs = ["👋", "😮", "😅", "😤"];
    const now = performance.now();
    for (const s of snakes) {
      const e = emotes.get(s.id);
      if (!e || e.until < now) continue;
      const r = radiusOf(s.mass);
      const life = (e.until - now) / 2200;
      const rise = (1 - life) * 18;
      ctx.globalAlpha = Math.min(1, life * 3);
      ctx.font = `${Math.max(18, 26 / z)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(glyphs[e.id] ?? "👋", s.x, s.y - r * 1.6 - rise);
      ctx.globalAlpha = 1;
    }
  }

  /** The afterlife wisp: a bright mote with a fading trail. */
  private drawWisp(
    ctx: CanvasRenderingContext2D,
    w: { x: number; y: number; angle: number; trail: Vec[] },
    z: number,
  ): void {
    ctx.globalCompositeOperation = "lighter";
    const n = w.trail.length;
    for (let i = 0; i < n; i++) {
      const p = w.trail[i]!;
      const a = (i / n) * 0.35;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 + (i / n) * 6, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(191,233,255,${a})`;
      ctx.fill();
    }
    const g = ctx.createRadialGradient(w.x, w.y, 0, w.x, w.y, WISP_REACH);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(0.2, "rgba(191,233,255,0.45)");
    g.addColorStop(0.7, "rgba(191,233,255,0.1)");
    g.addColorStop(1, "rgba(191,233,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(w.x - WISP_REACH, w.y - WISP_REACH, WISP_REACH * 2, WISP_REACH * 2);
    // The pickup halo, so the reach is something you can see and aim with.
    ctx.beginPath();
    ctx.arc(w.x, w.y, WISP_REACH, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(191,233,255,0.28)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    ctx.arc(w.x, w.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.font = `500 ${Math.max(11, 12 / z)}px Outfit, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "rgba(232,234,238,0.6)";
    ctx.fillText("wisp", w.x, w.y - 14);
  }

  /**
   * The weekly league as a frame around the head in the league's own shape
   * and colour: the only outline a head carries, so the tier reads from the
   * silhouette at any zoom. The stroke never drops under 2.2 screen pixels;
   * Diamond alone glows.
   */
  private drawLeagueRing(ctx: CanvasRenderingContext2D, s: Snake, r: number, z: number): void {
    const i = (s.league ?? 0) - 1;
    const shape = LEAGUE_SHAPES[i];
    if (!shape) return;
    const color = LEAGUE_COLORS[i]!;
    const size = r * 1.34 * 2;
    ctx.lineJoin = "round";
    if (i === 4) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.22 + Math.sin(this.time * 4) * 0.06;
      crestPath(ctx, shape, s.x, s.y, size);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(3, r * 0.5);
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
    crestPath(ctx, shape, s.x, s.y, size);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2.2 / z, r * 0.16);
    ctx.stroke();
  }

  /**
   * A promotion as everyone in view sees it: the new frame expands from the
   * head and fades over half a second, and the tier's name floats above the
   * head for a moment longer.
   */
  private drawPromotion(
    ctx: CanvasRenderingContext2D,
    s: Snake,
    r: number,
    z: number,
    promo: Promotion,
  ): void {
    const i = promo.tier - 1;
    const shape = LEAGUE_SHAPES[i];
    if (!shape) return;
    const color = LEAGUE_COLORS[i]!;
    const age = (performance.now() - promo.at) / 1000;
    if (age < 0.5) {
      const t = age / 0.5;
      ctx.globalAlpha = 0.9 * (1 - t);
      crestPath(ctx, shape, s.x, s.y, r * (1.34 + 1.06 * t) * 2);
      ctx.strokeStyle = color;
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(2.2 / z, r * 0.16);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (age < 1.6) {
      ctx.globalAlpha = Math.min(1, (1.6 - age) * 2);
      ctx.font = `700 ${Math.max(18, 26 / z)}px Outfit, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = color;
      ctx.fillText(LEAGUES[i]!.name, s.x, s.y - r * 1.6 - 22 / z - (age * 14) / z);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Last week's banked finish, Gold and up: a soft glow behind the head in
   * that tier's colour, drawn under the head so it never competes with the
   * frame that says what this week is.
   */
  private drawFinishAura(ctx: CanvasRenderingContext2D, s: Snake, r: number): void {
    const [cr, cg, cb] = hexRgb(LEAGUE_COLORS[(s.finish ?? 3) - 1] ?? LEAGUE_COLORS[2]);
    const pulse = 0.22 + Math.sin(this.time * 1.6) * 0.04;
    const g = ctx.createRadialGradient(s.x, s.y, r * 1.1, s.x, s.y, r * 2.2);
    g.addColorStop(0, `rgba(${cr},${cg},${cb},${pulse})`);
    g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(s.x - r * 2.2, s.y - r * 2.2, r * 4.4, r * 4.4);
  }

  /** A gold crown floating above a crowned head. */
  private drawCrown(ctx: CanvasRenderingContext2D, s: Snake, r: number): void {
    const cx = s.x;
    const cy = s.y - r * 1.5 - 6;
    const w = Math.max(10, r * 0.9);
    const h = w * 0.7;
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, cy + h / 2);
    ctx.lineTo(cx - w / 2, cy - h / 4);
    ctx.lineTo(cx - w / 4, cy + h / 8);
    ctx.lineTo(cx, cy - h / 2);
    ctx.lineTo(cx + w / 4, cy + h / 8);
    ctx.lineTo(cx + w / 2, cy - h / 4);
    ctx.lineTo(cx + w / 2, cy + h / 2);
    ctx.closePath();
    ctx.fillStyle = "#f0c14a";
    ctx.fill();
    ctx.strokeStyle = "rgba(120,80,0,0.6)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** The boss: a red glow along the body and a hit-point bar over the head. */
  private drawBossMarks(ctx: CanvasRenderingContext2D, s: Snake, r: number): void {
    const frac = Math.max(0, Math.min(1, (s.hp ?? 0) / (s.hpMax ?? 1)));
    const bw = r * 6;
    const bx = s.x - bw / 2;
    const by = s.y - r * 1.9 - 10;
    ctx.fillStyle = "rgba(7,9,15,0.7)";
    ctx.fillRect(bx - 2, by - 2, bw + 4, 12);
    ctx.fillStyle = "rgba(255,90,110,0.95)";
    ctx.fillRect(bx, by, bw * frac, 8);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, 8);
  }

  /** A faint ring where your all-time best run ended. */
  private drawGhost(
    ctx: CanvasRenderingContext2D,
    g: { x: number; y: number; best: number },
    z: number,
  ): void {
    const pulse = 26 + Math.sin(this.time * 2) * 4;
    ctx.beginPath();
    ctx.arc(g.x, g.y, pulse, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(232,234,238,0.22)";
    ctx.lineWidth = 2 / z;
    ctx.setLineDash([6 / z, 6 / z]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(g.x, g.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(232,234,238,0.35)";
    ctx.fill();
    ctx.font = `500 ${Math.max(11, 12 / z)}px Outfit, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(232,234,238,0.4)";
    ctx.fillText(`your best · ${g.best}`, g.x, g.y + pulse + 6);
  }

  private drawArena(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): void {
    if (!this.hexPattern && this.hexTile) {
      this.hexPattern = ctx.createPattern(this.hexTile, "repeat");
    }
    if (this.hexPattern) {
      ctx.fillStyle = this.hexPattern;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }

    ctx.fillStyle = "rgba(232,234,238,0.09)";
    for (const s of this.stars) {
      if (s.x < x0 || s.x > x1 || s.y < y0 || s.y > y1) continue;
      ctx.fillRect(s.x, s.y, 2, 2);
    }

    // Everything outside the rim is dimmed, then the rim itself glows red.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0 - 10, y0 - 10, x1 - x0 + 20, y1 - y0 + 20);
    ctx.arc(0, 0, ARENA_RADIUS, 0, Math.PI * 2, true);
    ctx.fillStyle = "rgba(3,4,8,0.8)";
    ctx.fill();
    ctx.restore();

    const near = Math.hypot(cam.x, cam.y) > ARENA_RADIUS - Math.max(x1 - x0, y1 - y0);
    if (!near) return;
    ctx.beginPath();
    ctx.arc(0, 0, ARENA_RADIUS + 22, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(220,70,90,0.16)";
    ctx.lineWidth = 44;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, ARENA_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(235,80,100,0.9)";
    ctx.lineWidth = 8;
    ctx.stroke();
  }

  /**
   * Named places: a glowing core at the centre, dark rings and a shard. They
   * never affect play; they make the arena a map you can learn.
   */
  private drawLandmarks(
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    z: number,
  ): void {
    const t = this.time;
    for (const l of LANDMARKS) {
      if (l.x < x0 - 900 || l.x > x1 + 900 || l.y < y0 - 900 || l.y > y1 + 900) continue;
      if (l.kind === 0) {
        const pulse = 1 + Math.sin(t * 0.8) * 0.06;
        const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, 760 * pulse);
        g.addColorStop(0, "rgba(62,224,196,0.22)");
        g.addColorStop(0.25, "rgba(62,224,196,0.08)");
        g.addColorStop(1, "rgba(62,224,196,0)");
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = g;
        ctx.fillRect(l.x - 800, l.y - 800, 1600, 1600);
        ctx.globalCompositeOperation = "source-over";
        ctx.beginPath();
        ctx.arc(l.x, l.y, 46 * pulse, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(200,255,245,0.18)";
        ctx.fill();
        for (let i = 0; i < 8; i++) {
          const a = t * 0.25 + (i / 8) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(l.x + Math.cos(a) * 240, l.y + Math.sin(a) * 240, 5, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(62,224,196,0.35)";
          ctx.fill();
        }
      } else if (l.kind === 1) {
        ctx.beginPath();
        ctx.arc(l.x, l.y, 520, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 34;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(l.x, l.y, 520, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(180,190,210,0.16)";
        ctx.lineWidth = 6;
        ctx.setLineDash([60, 40]);
        ctx.lineDashOffset = -t * 20;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(l.x, l.y, 380, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(180,190,210,0.08)";
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.save();
        ctx.translate(l.x, l.y);
        ctx.rotate(t * 0.1);
        for (const [k, a] of [
          [1, 0.16],
          [0.62, 0.1],
        ] as const) {
          ctx.beginPath();
          ctx.moveTo(0, -420 * k);
          ctx.lineTo(240 * k, 0);
          ctx.lineTo(0, 420 * k);
          ctx.lineTo(-240 * k, 0);
          ctx.closePath();
          ctx.strokeStyle = `rgba(155,140,255,${a})`;
          ctx.lineWidth = 4;
          ctx.stroke();
        }
        ctx.restore();
        const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, 300);
        g.addColorStop(0, "rgba(155,140,255,0.16)");
        g.addColorStop(1, "rgba(155,140,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(l.x - 300, l.y - 300, 600, 600);
      }
      ctx.font = `500 ${Math.max(12, 16 / z)}px Outfit, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = "rgba(232,234,238,0.22)";
      ctx.fillText(l.name, l.x, l.y + (l.kind === 1 ? 540 : l.kind === 2 ? 440 : 280));
    }
  }

  private drawFood(
    ctx: CanvasRenderingContext2D,
    world: World,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    z: number,
  ): void {
    const t = this.time;
    const minDest = 2.4 / z;
    const sprites = this.foodSprites;
    // Orbs under five screen pixels are batched into one path per colour
    // instead of one image draw each; zoomed out that is most of them.
    const tiny: { x: number; y: number; d: number }[][] = sprites.map(() => []);
    world.forEachFoodIn(x0, y0, x1, y1, (f) => {
      const spr = sprites[f.c % sprites.length];
      if (!spr) return;
      if (f.k < 2 && f.r * z < 2.5) {
        tiny[f.c % sprites.length]!.push({ x: f.x, y: f.y, d: f.r * 0.9 });
        return;
      }
      const wob = f.k === 3 || f.k === 4 ? 0.18 : f.k === 2 ? 0.14 : 0.09;
      const pulse = 1 - wob + Math.sin(t * (f.k >= 3 ? 6 : 2.6) + f.x * 0.07 + f.y * 0.05) * wob;
      const dest = spr.size * (f.r / 15) * pulse;
      if (dest < minDest) return;
      if (f.k >= 2) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = (f.k === 2 ? 0.16 : 0.26) + Math.sin(t * 5 + f.x) * 0.08;
        ctx.drawImage(spr.canvas, f.x - dest, f.y - dest, dest * 2, dest * 2);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.drawImage(spr.canvas, f.x - dest * 0.5, f.y - dest * 0.5, dest, dest);
    });
    tiny.forEach((list, c) => {
      if (!list.length) return;
      ctx.beginPath();
      for (const o of list) {
        ctx.moveTo(o.x + o.d, o.y);
        ctx.arc(o.x, o.y, o.d, 0, Math.PI * 2);
      }
      ctx.fillStyle = FOOD_COLORS[c] ?? "#ffffff";
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
    });
  }

  private boostSince = new Map<string, number>();
  private promos: ReadonlyMap<string, Promotion> | null = null;

  private segmentSprite(color: string, style?: SkinStyle): Sprite {
    const key = style ? `${style}|${color}` : color;
    let spr = this.segmentSprites.get(key);
    if (!spr) {
      spr = makeSegmentSprite(color, style);
      this.segmentSprites.set(key, spr);
    }
    return spr;
  }

  private drawSnake(
    ctx: CanvasRenderingContext2D,
    s: Snake,
    aim: Vec | null,
    cam: Camera,
    view: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    z: number,
  ): void {
    const bands = bandsOf(s);
    const shine = "#ffffff";
    const fill = bands[0]!;
    const r = radiusOf(s.mass);
    const pts = s.points;
    if (pts.length < 2) return;
    const span = view + lengthOf(s.mass) + r;
    if (dist2(s.x, s.y, cam.x, cam.y) > span * span) return;

    const len = pts.length;
    const invisible = r * z < 1.6;

    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Body path (shared by the glow, the shadow, and the tiny-zoom fallback).
    const tracePath = (dx: number, dy: number) => {
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x + dx, pts[0]!.y + dy);
      for (let i = 1; i < len; i++) ctx.lineTo(pts[i]!.x + dx, pts[i]!.y + dy);
      ctx.lineTo(s.x + dx, s.y + dy);
    };

    if (s.boss) {
      tracePath(0, 0);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.18 + Math.sin(this.time * 3) * 0.06;
      ctx.strokeStyle = "#ff5a6e";
      ctx.lineWidth = r * 3.6;
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
    if (s.boosting) {
      // Neon: the body's own colour, drawn additively in two widths.
      const pulse = 0.22 + Math.sin(this.time * 18) * 0.08;
      tracePath(0, 0);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = pulse * 0.6;
      ctx.strokeStyle = fill;
      ctx.lineWidth = r * 4.2;
      ctx.stroke();
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = shine;
      ctx.lineWidth = r * 2.6;
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    } else if (s.invuln > 0) {
      tracePath(0, 0);
      ctx.globalAlpha = 0.18 + Math.sin(this.time * 10) * 0.08;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = r * 2.8;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (invisible) {
      tracePath(0, 0);
      ctx.strokeStyle = fill;
      ctx.lineWidth = r * 2;
      ctx.stroke();
      return;
    }

    tracePath(r * 0.22, r * 0.36);
    ctx.strokeStyle = "rgba(0,0,0,0.34)";
    ctx.lineWidth = r * 2.2;
    ctx.stroke();

    // Segments, tail to head, so each disc overlaps the one behind it. Discs
    // are placed by distance walked along the path, not per point, so a
    // subsampled remote body looks identical to a local one.
    const size = r * 2.08;
    const half = size / 2;
    const step = Math.max(2.5, spacingOf(s.mass));
    const bandLen = Math.max(1, s.bands ? 3 : SKINS[s.skin % SKINS.length]!.band);
    const nBands = bands.length;
    const style = s.bands && s.bands.length ? undefined : SKINS[s.skin % SKINS.length]!.style;
    const sprites = bands.map((c) => this.segmentSprite(c, style));

    // Total path length so bands can be counted from the head. The trail
    // helpers keep it running; only a body edited elsewhere is re-walked.
    const cached = s.path;
    let total = cached && cached.pts === pts && cached.n === len ? cached.len : pathLength(pts);
    total += Math.hypot(s.x - pts[len - 1]!.x, s.y - pts[len - 1]!.y);
    const bandUnits = bandLen * step;

    let walked = 0;
    let next = 0;
    for (let i = 0; i < len; i++) {
      const a = pts[i]!;
      const b = i + 1 < len ? pts[i + 1]! : { x: s.x, y: s.y };
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      while (next <= walked + segLen) {
        const t = segLen > 0 ? (next - walked) / segLen : 0;
        const px = a.x + (b.x - a.x) * t;
        const py = a.y + (b.y - a.y) * t;
        if (px >= x0 - r && px <= x1 + r && py >= y0 - r && py <= y1 + r) {
          const fromHead = Math.max(0, total - next);
          const band = ((fromHead / bandUnits) | 0) % nBands;
          ctx.drawImage(sprites[band]!.canvas, px - half, py - half, size, size);
        }
        next += step;
      }
      walked += segLen;
    }
    if (s.x >= x0 - r && s.x <= x1 + r && s.y >= y0 - r && s.y <= y1 + r) {
      const hs = size * 1.06;
      // Last week's finish glows behind the head, under everything else.
      if ((s.finish ?? 0) >= 3) this.drawFinishAura(ctx, s, r);
      // Squash along the heading for 220 ms after a boost starts.
      if (s.boosting && !this.boostSince.has(s.id)) this.boostSince.set(s.id, this.time);
      if (!s.boosting) this.boostSince.delete(s.id);
      const since = this.boostSince.get(s.id);
      const k = since === undefined ? 0 : Math.max(0, 1 - (this.time - since) / 0.22);
      if (k > 0) {
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(s.angle);
        ctx.scale(1 - 0.2 * k, 1 + 0.2 * k);
        ctx.drawImage(sprites[0]!.canvas, -hs / 2, -hs / 2, hs, hs);
        ctx.restore();
      } else {
        ctx.drawImage(sprites[0]!.canvas, s.x - hs / 2, s.y - hs / 2, hs, hs);
      }
      if ((s.level ?? 0) >= 20) this.drawShimmer(ctx, s, r);
      if (s.league) this.drawLeagueRing(ctx, s, r, z);
      const promo = this.promos?.get(s.id);
      if (promo) this.drawPromotion(ctx, s, r, z, promo);
      if (s.crown) this.drawCrown(ctx, s, r);
      if (s.boss) this.drawBossMarks(ctx, s, r);
      this.drawEvolution(ctx, s, r);
      this.drawEyes(ctx, s, r, aim);
    }
  }

  /** Legendary (level 20+): a bright pulse travelling down the body twice a second. */
  private drawShimmer(ctx: CanvasRenderingContext2D, s: Snake, r: number): void {
    const pts = s.points;
    if (pts.length < 3) return;
    const frac = 1 - ((this.time * 0.5) % 1);
    const i = Math.min(pts.length - 1, Math.floor(frac * (pts.length - 1)));
    const p = pts[i]!;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 1.8);
    g.addColorStop(0, "rgba(255,255,255,0.55)");
    g.addColorStop(0.5, "rgba(255,240,180,0.2)");
    g.addColorStop(1, "rgba(255,240,180,0)");
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = g;
    ctx.fillRect(p.x - r * 1.8, p.y - r * 1.8, r * 3.6, r * 3.6);
    ctx.globalCompositeOperation = "source-over";
  }

  /** Evolution marks: dorsal dots from level 5, fins from 10 (level 20 adds the shimmer). */
  private drawEvolution(ctx: CanvasRenderingContext2D, s: Snake, r: number): void {
    const lv = s.level ?? 0;
    if (lv < 5) return;
    const pts = s.points;
    const step = Math.max(4, Math.floor(pts.length / 12));
    for (let i = pts.length - 4; i > 0; i -= step) {
      const a = pts[i]!;
      const b = pts[Math.max(0, i - 1)]!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.hypot(dx, dy) || 1;
      const nx = -dy / d;
      const ny = dx / d;
      if (lv >= 10) {
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(a.x + nx * side * r * 0.85, a.y + ny * side * r * 0.85);
          ctx.lineTo(a.x + nx * side * r * 1.35, a.y + ny * side * r * 1.35);
          ctx.lineTo(
            a.x + nx * side * r * 0.85 + (dx / d) * r * 0.3,
            a.y + ny * side * r * 0.85 + (dy / d) * r * 0.3,
          );
          ctx.closePath();
          ctx.fillStyle = "rgba(232,234,238,0.7)";
          ctx.fill();
        }
      } else {
        ctx.beginPath();
        ctx.arc(a.x, a.y, r * 0.22, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.fill();
      }
    }
  }

  private drawEyes(ctx: CanvasRenderingContext2D, s: Snake, r: number, aim: Vec | null): void {
    const ex = Math.cos(s.angle);
    const ey = Math.sin(s.angle);
    const px = -ey;
    const py = ex;
    const eye = r * 0.4;
    let lx = ex;
    let ly = ey;
    if (aim) {
      const dx = aim.x - s.x;
      const dy = aim.y - s.y;
      const d = Math.hypot(dx, dy);
      if (d > 4) {
        lx = dx / d;
        ly = dy / d;
      }
    }
    for (const side of [-1, 1]) {
      const cx = s.x + ex * r * 0.36 + px * side * r * 0.5;
      const cy = s.y + ey * r * 0.36 + py * side * r * 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, eye, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, eye, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = Math.max(0.6, r * 0.06);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + lx * eye * 0.4, cy + ly * eye * 0.4, eye * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = "#101318";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(
        cx + lx * eye * 0.25 - eye * 0.18,
        cy + ly * eye * 0.25 - eye * 0.22,
        eye * 0.16,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fill();
    }
  }

  private drawAim(ctx: CanvasRenderingContext2D, aim: Vec, z: number): void {
    ctx.beginPath();
    ctx.arc(aim.x, aim.y, 5 / z, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(232,234,238,0.3)";
    ctx.lineWidth = 1.4 / z;
    ctx.stroke();
  }

  private drawParticles(ctx: CanvasRenderingContext2D, particles: Particle[]): void {
    for (const p of particles) {
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawFloaters(ctx: CanvasRenderingContext2D, floaters: Floater[], z: number): void {
    const px = clamp(14 / z, 12, 40);
    ctx.font = `600 ${px}px Outfit, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const f of floaters) {
      ctx.globalAlpha = clamp(f.life * 1.4, 0, 1);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  private drawNames(
    ctx: CanvasRenderingContext2D,
    snakes: Snake[],
    cam: Camera,
    w: number,
    h: number,
    dpr: number,
    z: number,
    ox: number,
    oy: number,
    ranks: ReadonlyMap<string, number> | null,
  ): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cssW = w / dpr;
    const cssH = h / dpr;
    // The tag carries exactly two rank marks: the league crest and, for the
    // arena's top three, a numeral square. Level and might live in the
    // player list and the profile, so the tag stays a name.
    const font = "500 13px Outfit, sans-serif";
    for (const s of snakes) {
      const sx = (s.x - cam.x - ox) * z + cssW / 2;
      const sy = (s.y - cam.y - oy) * z + cssH / 2;
      if (sx < -40 || sy < -40 || sx > cssW + 40 || sy > cssH + 40) continue;
      const r = radiusOf(s.mass) * z;
      const rank = ranks?.get(s.id);
      const tier = s.boss ? 0 : (s.league ?? 0);
      const label = s.boss
        ? `BOSS · ${s.name}`
        : `${s.crown ? "👑 " : ""}${s.linked ? "✓ " : ""}${s.name} · ${Math.floor(s.mass)}`;
      ctx.font = font;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      const tw = ctx.measureText(label).width;
      const crestW = tier ? 18 : 0;
      const rankW = rank && rank <= 3 && !s.boss ? 18 : 0;
      const pad = 6;
      const y = sy - r - 10;
      const width = crestW + rankW + tw + pad * 2;
      const left = sx - width / 2;
      ctx.fillStyle = "rgba(7,9,15,0.5)";
      roundRect(ctx, left, y - 16, width, 18, 9);
      ctx.fill();
      if (rank === 1) {
        ctx.strokeStyle = "#d7dde8";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      let x = left + pad;
      if (crestW) {
        drawCrest(ctx, tier, x + 7, y - 7, 14);
        x += crestW;
      }
      if (rankW) {
        ctx.fillStyle = "rgba(7,9,15,0.85)";
        roundRect(ctx, x, y - 14, 14, 14, 3);
        ctx.fill();
        ctx.font = "700 10px Outfit, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#ffffff";
        ctx.fillText(String(rank), x + 7, y - 6.5);
        x += rankW;
      }
      ctx.font = font;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "rgba(238,241,246,0.92)";
      ctx.fillText(label, x, y);
    }
  }

  private drawMinimap(
    ctx: CanvasRenderingContext2D,
    snakes: Snake[],
    localId: string | null,
    w: number,
    h: number,
    dpr: number,
    phase: Phase,
    insets: { top: number; bottom: number },
    event: Vec | null,
    ghost: Vec | null,
    wisp: Vec | null = null,
    marks: readonly MapMark[] = [],
  ): void {
    if (phase === "menu") return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cssW = w / dpr;
    const cssH = h / dpr;
    const narrow = cssW < 640;
    const size = narrow ? 84 : 116;
    const m = 16;
    const cx = cssW - m - size / 2;
    // Phones: the boost button owns the bottom-right corner and the
    // leaderboard is hidden, so the map goes top-right under the notch.
    const cy = narrow ? insets.top + m + size / 2 : cssH - insets.bottom - m - size / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(7,9,15,0.7)";
    ctx.fill();
    ctx.strokeStyle = "rgba(235,80,100,0.7)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const k = (size / 2 - 6) / ARENA_RADIUS;
    for (const s of snakes) {
      if (s.id === localId) continue;
      const big = s.mass > 250;
      ctx.beginPath();
      ctx.arc(cx + s.x * k, cy + s.y * k, big ? 2.6 : 1.7, 0, Math.PI * 2);
      ctx.fillStyle = fillOf(s);
      ctx.globalAlpha = big ? 0.9 : 0.55;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Who matters on the map: the top three (white ring), bounty carriers
    // (gold ring) and Platinum or Diamond players (a dot in their colour).
    for (const mk of marks) {
      const mx = cx + mk.x * k;
      const my = cy + mk.y * k;
      ctx.beginPath();
      if (mk.kind === "tier") {
        ctx.arc(mx, my, 2.4, 0, Math.PI * 2);
        ctx.fillStyle = LEAGUE_COLORS[(mk.tier ?? 4) - 1] ?? LEAGUE_COLORS[3];
        ctx.fill();
        continue;
      }
      ctx.arc(mx, my, mk.kind === "top" ? 4.2 : 5.2, 0, Math.PI * 2);
      ctx.strokeStyle = mk.kind === "top" ? "rgba(255,255,255,0.85)" : "rgba(240,193,74,0.9)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    if (event) {
      const pulse = 4 + Math.sin(this.time * 6) * 1.5;
      ctx.beginPath();
      ctx.arc(cx + event.x * k, cy + event.y * k, pulse, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(240,193,74,0.9)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx + event.x * k, cy + event.y * k, pulse + 4, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(240,193,74,0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (ghost) {
      ctx.beginPath();
      ctx.arc(cx + ghost.x * k, cy + ghost.y * k, 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(232,234,238,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    for (const l of LANDMARKS) {
      ctx.beginPath();
      ctx.arc(cx + l.x * k, cy + l.y * k, l.kind === 0 ? 3 : 2, 0, Math.PI * 2);
      ctx.strokeStyle = l.kind === 0 ? "rgba(62,224,196,0.7)" : "rgba(180,190,210,0.45)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    const bossS = snakes.find((s) => s.boss && s.alive);
    if (bossS) {
      const pulse = 4 + Math.sin(this.time * 4) * 1.2;
      ctx.beginPath();
      ctx.arc(cx + bossS.x * k, cy + bossS.y * k, pulse, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,90,110,0.9)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    const me = snakes.find((s) => s.id === localId) ?? wisp;
    if (me) {
      ctx.beginPath();
      ctx.arc(cx + me.x * k, cy + me.y * k, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx + me.x * k, cy + me.y * k, 6.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /** Touch joystick indicator, in CSS pixels. */
  drawStick(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    st: { ox: number; oy: number; x: number; y: number },
  ): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const R = 46;
    const dx = st.x - st.ox;
    const dy = st.y - st.oy;
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, d / R);
    ctx.beginPath();
    ctx.arc(st.ox, st.oy, R, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(232,234,238,0.25)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(st.ox + (dx / d) * R * k, st.oy + (dy / d) * R * k, 18, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(232,234,238,0.45)";
    ctx.fill();
  }
}

export function desiredZoom(mass: number, phase: Phase): number {
  if (phase === "menu") return 0.55;
  if (phase === "dead") return clamp(zoomOf(mass) * 0.85, 0.28, 0.7);
  return zoomOf(mass);
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function shade(rgb: [number, number, number], k: number): string {
  const [r, g, b] = rgb;
  const f = (c: number) => clamp(Math.round(k >= 0 ? c + (255 - c) * k : c * (1 + k)), 0, 255);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

function makeFoodSprite(color: string): Sprite {
  const size = SPRITE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const rgb = hexRgb(color);
  const [r, g, b] = rgb;
  const cx = 32;
  const cy = 32;
  let grd = ctx.createRadialGradient(cx, cy, 2, cx, cy, 31);
  grd.addColorStop(0, `rgba(${r},${g},${b},0.35)`);
  grd.addColorStop(0.5, `rgba(${r},${g},${b},0.16)`);
  grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);

  grd = ctx.createRadialGradient(cx - 5, cy - 6, 1, cx, cy, 16);
  grd.addColorStop(0, shade(rgb, 0.7));
  grd.addColorStop(0.5, color);
  grd.addColorStop(1, shade(rgb, -0.25));
  ctx.beginPath();
  ctx.arc(cx, cy, 15, 0, Math.PI * 2);
  ctx.fillStyle = grd;
  ctx.fill();
  return { canvas, size };
}

/** A shaded disc used as one body segment. */
function makeSegmentSprite(color: string, style?: SkinStyle): Sprite {
  const size = SPRITE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const rgb = hexRgb(color);
  const cx = 32;
  const cy = 32;
  // Glossy sphere: bright specular top-left, saturated mid, deep shadow at
  // the rim, then a thin rim light and a dark outline so discs read as one
  // rounded body rather than a chain of flat circles.
  const grd = ctx.createRadialGradient(cx - 10, cy - 11, 2, cx, cy, 31);
  grd.addColorStop(0, shade(rgb, 0.6));
  grd.addColorStop(0.28, shade(rgb, 0.14));
  grd.addColorStop(0.72, shade(rgb, -0.08));
  grd.addColorStop(1, shade(rgb, -0.52));
  ctx.beginPath();
  ctx.arc(cx, cy, 31, 0, Math.PI * 2);
  ctx.fillStyle = grd;
  ctx.fill();
  if (style === "scales") {
    // Three overlapping crescents in the lower half read as scales.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 31, 0, Math.PI * 2);
    ctx.clip();
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 2.4;
    for (const [ox, oy] of [
      [-11, 6],
      [11, 6],
      [0, 18],
      [-16, 22],
      [16, 22],
    ] as const) {
      ctx.beginPath();
      ctx.arc(cx + ox, cy + oy - 10, 11, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + ox, cy + oy - 12, 11, Math.PI * 0.2, Math.PI * 0.8);
      ctx.strokeStyle = "rgba(255,255,255,0.14)";
      ctx.stroke();
      ctx.strokeStyle = "rgba(0,0,0,0.22)";
    }
    ctx.restore();
  } else if (style === "stripes") {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 31, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.beginPath();
    ctx.moveTo(cx - 40, cy + 2);
    ctx.lineTo(cx + 40, cy - 22);
    ctx.lineTo(cx + 40, cy - 10);
    ctx.lineTo(cx - 40, cy + 14);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, 28.5, Math.PI * 1.05, Math.PI * 1.55);
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 28.5, Math.PI * 0.15, Math.PI * 0.6);
  ctx.strokeStyle = "rgba(0,0,0,0.22)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 30.3, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0,0,0,0.38)";
  ctx.lineWidth = 1.7;
  ctx.stroke();
  return { canvas, size };
}

/** A seamless 768px tile of soft colour clouds; drawn with parallax behind the grid. */
function makeNebula(): HTMLCanvasElement {
  const size = 768;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#05070c";
  ctx.fillRect(0, 0, size, size);
  const blobs: [number, number, number, string][] = [
    [0.2, 0.3, 300, "36,120,150"],
    [0.75, 0.2, 260, "95,70,170"],
    [0.55, 0.7, 320, "40,80,150"],
    [0.15, 0.85, 220, "150,60,120"],
    [0.9, 0.65, 240, "30,110,120"],
  ];
  ctx.globalCompositeOperation = "lighter";
  for (const [fx, fy, rad, rgb] of blobs) {
    // Draw each blob at the eight wrapped positions too, so the tile repeats
    // without seams.
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const x = fx * size + ox * size;
        const y = fy * size + oy * size;
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, `rgba(${rgb},0.22)`);
        g.addColorStop(0.5, `rgba(${rgb},0.09)`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      }
    }
  }
  ctx.globalCompositeOperation = "source-over";
  const stars = makeStarTile();
  for (let x = 0; x < size; x += 256)
    for (let y = 0; y < size; y += 256) ctx.drawImage(stars, x, y, 256, 256);
  return canvas;
}

/** A 512px tile of faint distant stars for the far parallax layer. */
function makeStarTile(): HTMLCanvasElement {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 90; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 0.5 + rnd() * 1.1;
    const a = 0.25 + rnd() * 0.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${rnd() > 0.8 ? "180,210,255" : "232,234,238"},${a})`;
    ctx.fill();
  }
  return canvas;
}

/** One repeat of a pointy-top hexagon grid, drawn in world units. */
function makeHexTile(): HTMLCanvasElement {
  const a = HEX;
  const w = Math.sqrt(3) * a;
  const h = 3 * a;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w);
  canvas.height = Math.round(h);
  const ctx = canvas.getContext("2d")!;
  const sx = canvas.width / w;
  const sy = canvas.height / h;
  ctx.scale(sx, sy);
  ctx.strokeStyle = "rgba(232,234,238,0.045)";
  ctx.lineWidth = 1.4;
  const hex = (cx: number, cy: number) => {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const ang = Math.PI / 6 + (i * Math.PI) / 3;
      const x = cx + Math.cos(ang) * a;
      const y = cy + Math.sin(ang) * a;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  };
  hex(w / 2, a);
  hex(0, 2.5 * a);
  hex(w, 2.5 * a);
  hex(w / 2, 4 * a);
  hex(w / 2, -2 * a);
  hex(0, -0.5 * a);
  hex(w, -0.5 * a);
  return canvas;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
