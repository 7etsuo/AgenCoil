import {
  ARENA_RADIUS,
  FOOD_COLORS,
  SKINS,
  type Camera,
  type Floater,
  type Food,
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

const GRID = 72;

interface FoodSprite {
  canvas: HTMLCanvasElement;
  size: number;
}

export class Renderer {
  private stars: Vec[] = [];
  private foodSprites: FoodSprite[] = [];
  private time = 0;

  constructor() {
    for (let i = 0; i < 140; i++) {
      const p = {
        x: (Math.random() * 2 - 1) * ARENA_RADIUS,
        y: (Math.random() * 2 - 1) * ARENA_RADIUS,
      };
      if (p.x * p.x + p.y * p.y < ARENA_RADIUS * ARENA_RADIUS) this.stars.push(p);
    }
    this.foodSprites = FOOD_COLORS.map((c) => makeFoodSprite(c));
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
    foods: Food[],
    snakes: Snake[],
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

    ctx.setTransform(z * dpr, 0, 0, z * dpr, w / 2 - (cam.x + ox) * z * dpr, h / 2 - (cam.y + oy) * z * dpr);

    this.drawArena(ctx, cam, w, h, z);
    this.drawFood(ctx, foods, cam, w, h, z);
    this.drawParticles(ctx, particles);

    const ordered = snakes.slice().sort((a, b) => a.mass - b.mass);
    const view = Math.hypot(w, h) / z / 2 + 80;
    for (const s of ordered) this.drawSnake(ctx, s, s.id === localId, cam, view);
    if (phase === "play" && aim) this.drawAim(ctx, aim);

    this.drawFloaters(ctx, floaters);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawNames(ctx, snakes, cam, w, h, dpr, z, ox, oy);
    this.drawMinimap(ctx, snakes, localId, w, h, dpr, phase);
  }

  private drawArena(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number, z: number): void {
    const view = Math.hypot(w, h) / z / 2 + 80;
    const x0 = cam.x - view;
    const y0 = cam.y - view;
    const x1 = cam.x + view;
    const y1 = cam.y + view;

    ctx.strokeStyle = "rgba(232,234,238,0.035)";
    ctx.lineWidth = 1.1;
    let step = GRID;
    const span = Math.max(x1 - x0, y1 - y0);
    if (span / step > 40) step = Math.ceil(span / 40 / GRID) * GRID;
    const g0 = Math.floor(x0 / step) * step;
    const g1 = Math.ceil(x1 / step) * step;
    const h0 = Math.floor(y0 / step) * step;
    const h1 = Math.ceil(y1 / step) * step;
    ctx.beginPath();
    for (let x = g0; x <= g1; x += step) {
      ctx.moveTo(x, h0);
      ctx.lineTo(x, h1);
    }
    for (let y = h0; y <= h1; y += step) {
      ctx.moveTo(g0, y);
      ctx.lineTo(g1, y);
    }
    ctx.stroke();

    ctx.fillStyle = "rgba(232,234,238,0.07)";
    for (const s of this.stars) {
      if (s.x < x0 || s.x > x1 || s.y < y0 || s.y > y1) continue;
      ctx.fillRect(s.x, s.y, 1.6, 1.6);
    }

    ctx.beginPath();
    ctx.arc(0, 0, ARENA_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(196,92,106,0.85)";
    ctx.lineWidth = 10;
    ctx.setLineDash([22, 16]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(0, 0, ARENA_RADIUS + 18, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(196,92,106,0.18)";
    ctx.lineWidth = 26;
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    const pad = view * 2;
    ctx.rect(cam.x - pad, cam.y - pad, pad * 2, pad * 2);
    ctx.arc(0, 0, ARENA_RADIUS, 0, Math.PI * 2, true);
    ctx.fillStyle = "rgba(4,6,10,0.72)";
    ctx.fill();
    ctx.restore();
  }

  private drawFood(ctx: CanvasRenderingContext2D, foods: Food[], cam: Camera, w: number, h: number, z: number): void {
    const view = Math.hypot(w, h) / z / 2 + 48;
    const view2 = view * view;
    const minDest = 3.2 / z;
    for (const f of foods) {
      const dx = f.x - cam.x;
      const dy = f.y - cam.y;
      if (dx * dx + dy * dy > view2) continue;
      const spr = this.foodSprites[f.c % this.foodSprites.length];
      if (!spr) continue;
      const pulse = 0.9 + Math.sin(this.time * 2.5 + f.x * 0.07) * 0.1;
      const dest = spr.size * (f.r / 15) * pulse;
      if (dest < minDest) continue;
      ctx.drawImage(spr.canvas, f.x - dest * 0.5, f.y - dest * 0.5, dest, dest);
    }
  }

  private drawSnake(ctx: CanvasRenderingContext2D, s: Snake, _isLocal: boolean, cam: Camera, view: number): void {
    const skin = SKINS[s.skin % SKINS.length]!;
    const r = radiusOf(s.mass);
    const pts = s.points;
    if (pts.length < 2) return;
    if (dist2(s.x, s.y, cam.x, cam.y) > (view + lengthOf(s.mass) + r) * (view + lengthOf(s.mass) + r)) return;

    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    const tail = pts[pts.length - 1]!;
    if (tail.x !== s.x || tail.y !== s.y) ctx.lineTo(s.x, s.y);

    ctx.globalAlpha = s.boosting ? 0.28 : s.invuln > 0 ? 0.22 : 0.14;
    ctx.strokeStyle = skin.fill;
    ctx.lineWidth = r * 2.5;
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.strokeStyle = s.boosting ? skin.shine : skin.fill;
    ctx.lineWidth = r * 2;
    ctx.stroke();

    ctx.strokeStyle = skin.alt;
    ctx.lineWidth = r * 2;
    ctx.setLineDash([r * 1.05, r * 2.15]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 1.06, 0, Math.PI * 2);
    ctx.fillStyle = s.boosting ? skin.shine : skin.fill;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s.x - r * 0.28, s.y - r * 0.28, r * 0.38, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.fill();

    const ex = Math.cos(s.angle);
    const ey = Math.sin(s.angle);
    const px = -ey;
    const py = ex;
    const eye = r * 0.42;
    for (const side of [-1, 1]) {
      const ox = s.x + ex * r * 0.42 + px * side * r * 0.38;
      const oy = s.y + ey * r * 0.42 + py * side * r * 0.38;
      ctx.beginPath();
      ctx.arc(ox, oy, eye, 0, Math.PI * 2);
      ctx.fillStyle = "#f8fafc";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ox + ex * eye * 0.28, oy + ey * eye * 0.28, eye * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = "#12141a";
      ctx.fill();
    }
  }

  private drawAim(ctx: CanvasRenderingContext2D, aim: Vec): void {
    ctx.beginPath();
    ctx.arc(aim.x, aim.y, 5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(232,234,238,0.35)";
    ctx.lineWidth = 1.4;
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

  private drawFloaters(ctx: CanvasRenderingContext2D, floaters: Floater[]): void {
    ctx.font = "600 14px Outfit, sans-serif";
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
      ctx.fillStyle = "rgba(7,9,15,0.45)";
      const label = s.name;
      const tw = ctx.measureText(label).width;
      const pad = 6;
      const y = sy - r - 8;
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
    const size = cssW < 640 ? 84 : 108;
    const m = 16;
    const cx = cssW - m - size / 2;
    const cy = cssH - m - size / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(7,9,15,0.72)";
    ctx.fill();
    ctx.strokeStyle = "rgba(232,234,238,0.16)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2 - 5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(196,92,106,0.65)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    const k = (size / 2 - 8) / ARENA_RADIUS;
    for (const s of snakes) {
      const skin = SKINS[s.skin % SKINS.length]!;
      const x = cx + s.x * k;
      const y = cy + s.y * k;
      ctx.beginPath();
      ctx.arc(x, y, s.id === localId ? 3.4 : 2.2, 0, Math.PI * 2);
      ctx.fillStyle = s.id === localId ? "#f8fafc" : skin.fill;
      ctx.fill();
    }
  }
}

export function desiredZoom(mass: number, phase: Phase): number {
  if (phase === "menu") return 0.48;
  if (phase === "dead") return clamp(zoomOf(mass) * 0.85, 0.28, 0.7);
  return zoomOf(mass);
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function makeFoodSprite(color: string): FoodSprite {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const [r, g, b] = hexRgb(color);
  const cx = 32;
  const cy = 32;
  let grd = ctx.createRadialGradient(cx, cy, 2, cx, cy, 30);
  grd.addColorStop(0, `rgba(${r},${g},${b},0)`);
  grd.addColorStop(0.45, `rgba(${Math.min(255, r + 40)},${Math.min(255, g + 40)},${Math.min(255, b + 40)},0.18)`);
  grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);

  grd = ctx.createRadialGradient(cx - 6, cy - 8, 2, cx, cy, 18);
  grd.addColorStop(0, `rgb(${Math.min(255, r + 90)},${Math.min(255, g + 90)},${Math.min(255, b + 90)})`);
  grd.addColorStop(0.45, `rgb(${r},${g},${b})`);
  grd.addColorStop(1, `rgb(${Math.max(0, r - 50)},${Math.max(0, g - 50)},${Math.max(0, b - 50)})`);
  ctx.beginPath();
  ctx.arc(cx, cy, 16, 0, Math.PI * 2);
  ctx.fillStyle = grd;
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(cx - 5, cy - 6, 5.5, 3.4, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.fill();
  return { canvas, size };
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
