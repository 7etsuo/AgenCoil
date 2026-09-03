import {
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
  zoomOf,
} from "./model";
import type { World } from "./world";

const HEX = 44;
const SPRITE = 64;

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
  }

  stepFx(dt: number, particles: Particle[], floaters: Floater[], cam: Camera): void {
    this.time += dt;
    cam.trauma = Math.max(0, cam.trauma - dt * 1.8);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!;
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      p.vy *= 0.96;
      if (p.life <= 0) particles.splice(i, 1);
    }
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i]!;
      f.life -= dt;
      f.y -= 28 * dt;
      if (f.life <= 0) floaters.splice(i, 1);
    }
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
  ): void {
    const shake = cam.trauma * cam.trauma;
    const ox = (Math.random() * 2 - 1) * shake * 14;
    const oy = (Math.random() * 2 - 1) * shake * 14;
    const z = cam.z;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#07090f";
    ctx.fillRect(0, 0, w, h);

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
    this.drawFood(ctx, world, x0, y0, x1, y1, z);
    this.drawParticles(ctx, particles);

    const snakes = world.snakes;
    const ordered = snakes.slice().sort((a, b) => a.mass - b.mass);
    const view = Math.hypot(viewW, viewH) / 2 + 80;
    for (const s of ordered) {
      this.drawSnake(ctx, s, s.id === localId ? aim : null, cam, view, x0, y0, x1, y1, z);
    }
    if (phase === "play" && aim) this.drawAim(ctx, aim, z);

    this.drawFloaters(ctx, floaters, z);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawNames(ctx, snakes, cam, w, h, dpr, z, ox, oy);
    this.drawMinimap(ctx, snakes, localId, w, h, dpr, phase);
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
    world.forEachFoodIn(x0, y0, x1, y1, (f) => {
      const spr = sprites[f.c % sprites.length];
      if (!spr) return;
      const wob = f.k === 3 ? 0.18 : f.k === 2 ? 0.14 : 0.09;
      const pulse = 1 - wob + Math.sin(t * (f.k === 3 ? 6 : 2.6) + f.x * 0.07 + f.y * 0.05) * wob;
      const dest = spr.size * (f.r / 15) * pulse;
      if (dest < minDest) return;
      if (f.k === 3) {
        ctx.globalAlpha = 0.22 + Math.sin(t * 5 + f.x) * 0.08;
        ctx.drawImage(spr.canvas, f.x - dest, f.y - dest, dest * 2, dest * 2);
        ctx.globalAlpha = 1;
      }
      ctx.drawImage(spr.canvas, f.x - dest * 0.5, f.y - dest * 0.5, dest, dest);
    });
  }

  private segmentSprite(color: string): Sprite {
    let spr = this.segmentSprites.get(color);
    if (!spr) {
      spr = makeSegmentSprite(color);
      this.segmentSprites.set(color, spr);
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

    if (s.boosting) {
      const pulse = 0.28 + Math.sin(this.time * 18) * 0.1;
      tracePath(0, 0);
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = shine;
      ctx.lineWidth = r * 3.2;
      ctx.stroke();
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

    tracePath(r * 0.22, r * 0.34);
    ctx.strokeStyle = "rgba(0,0,0,0.32)";
    ctx.lineWidth = r * 2;
    ctx.stroke();

    // Segments, tail to head, so each disc overlaps the one behind it. Discs
    // are placed by distance walked along the path, not per point, so a
    // subsampled remote body looks identical to a local one.
    const size = r * 2.08;
    const half = size / 2;
    const step = Math.max(2.5, r * 0.5);
    const bandLen = Math.max(1, s.bands ? 3 : SKINS[s.skin % SKINS.length]!.band);
    const nBands = bands.length;
    const sprites = bands.map((c) => this.segmentSprite(c));

    // Total path length so bands can be counted from the head.
    let total = 0;
    for (let i = 1; i < len; i++)
      total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
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
      ctx.drawImage(sprites[0]!.canvas, s.x - hs / 2, s.y - hs / 2, hs, hs);
      this.drawEyes(ctx, s, r, aim);
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
  ): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = "500 13px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const cssW = w / dpr;
    const cssH = h / dpr;
    for (const s of snakes) {
      const sx = (s.x - cam.x - ox) * z + cssW / 2;
      const sy = (s.y - cam.y - oy) * z + cssH / 2;
      if (sx < -40 || sy < -40 || sx > cssW + 40 || sy > cssH + 40) continue;
      const r = radiusOf(s.mass) * z;
      const label = `${s.name} · ${Math.floor(s.mass)}`;
      const tw = ctx.measureText(label).width;
      const pad = 6;
      const y = sy - r - 10;
      ctx.fillStyle = "rgba(7,9,15,0.5)";
      roundRect(ctx, sx - tw / 2 - pad, y - 16, tw + pad * 2, 18, 9);
      ctx.fill();
      ctx.fillStyle = "rgba(238,241,246,0.92)";
      ctx.fillText(label, sx, y);
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
  ): void {
    if (phase === "menu") return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cssW = w / dpr;
    const cssH = h / dpr;
    const size = cssW < 640 ? 88 : 116;
    const m = 16;
    const cx = cssW - m - size / 2;
    const cy = cssH - m - size / 2;
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
    const me = snakes.find((s) => s.id === localId);
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
function makeSegmentSprite(color: string): Sprite {
  const size = SPRITE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const rgb = hexRgb(color);
  const cx = 32;
  const cy = 32;
  const grd = ctx.createRadialGradient(cx - 9, cy - 10, 2, cx, cy, 31);
  grd.addColorStop(0, shade(rgb, 0.45));
  grd.addColorStop(0.35, shade(rgb, 0.08));
  grd.addColorStop(0.85, shade(rgb, -0.18));
  grd.addColorStop(1, shade(rgb, -0.45));
  ctx.beginPath();
  ctx.arc(cx, cy, 31, 0, Math.PI * 2);
  ctx.fillStyle = grd;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, 30.4, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0,0,0,0.28)";
  ctx.lineWidth = 1.6;
  ctx.stroke();
  return { canvas, size };
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
  ctx.strokeStyle = "rgba(232,234,238,0.055)";
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
