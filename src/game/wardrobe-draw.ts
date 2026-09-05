/**
 * Drawing the wardrobe: every catalog item as a small Canvas 2D routine,
 * shared by the arena renderer and the menu preview so both show the same
 * thing. Positions are world units around a head of radius `r`; body items
 * get the sampled discs of the body with their tangents.
 */
import { LEAGUE_COLORS } from "./challenges";
import { GROWTH_PLATES, GROWTH_SPIKES, GROWTH_GLOW, cosmeticById } from "./cosmetics";

/** A sampled body disc: position, unit tangent toward the head, index from the head (0 under the head). */
export interface Seg {
  x: number;
  y: number;
  tx: number;
  ty: number;
  i: number;
}

export interface NameStyle {
  color?: string;
  outline?: string;
  glow?: string;
  glyph?: string;
  bg?: string;
  border?: string;
}

const TAU = Math.PI * 2;

/** A small hash for per-segment variety that holds still frame to frame. */
function jitter(i: number, salt = 0): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function tri(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): void {
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineTo(cx, cy);
  ctx.closePath();
}

// ── body ───────────────────────────────────────────────────────────────────────

/** A body piece hides the growth plates and spikes when it says so. */
export function coversGrowth(id: string | undefined): boolean {
  return Boolean(id && cosmeticById(id)?.coversGrowth);
}

/** Does this loadout need the body's sampled discs at all? */
export function wantsSegs(bodyId: string | undefined, mass: number): boolean {
  return Boolean(bodyId) || mass >= GROWTH_PLATES;
}

export function drawBodyItem(
  ctx: CanvasRenderingContext2D,
  id: string,
  segs: readonly Seg[],
  r: number,
  t: number,
): void {
  if (!segs.length) return;
  switch (id) {
    case "dorsal_ridge":
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = Math.max(0.6, r * 0.06);
      for (const s of segs) {
        if (s.i % 3) continue;
        const nx = -s.ty;
        const ny = s.tx;
        tri(
          ctx,
          s.x + s.tx * r * 0.35,
          s.y + s.ty * r * 0.35,
          s.x - s.tx * r * 0.25 + nx * r * 0.25,
          s.y - s.ty * r * 0.25 + ny * r * 0.25,
          s.x - s.tx * r * 0.25 - nx * r * 0.25,
          s.y - s.ty * r * 0.25 - ny * r * 0.25,
        );
        ctx.fill();
        ctx.stroke();
      }
      return;
    case "racing_stripes": {
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = Math.max(1, r * 0.12);
      ctx.lineJoin = "round";
      for (const side of [-1, 1]) {
        ctx.beginPath();
        segs.forEach((s, k) => {
          const x = s.x - s.ty * side * r * 0.5;
          const y = s.y + s.tx * side * r * 0.5;
          if (k) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.stroke();
      }
      return;
    }
    case "plate_armor":
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = Math.max(1, r * 0.08);
      for (const s of segs) {
        if (s.i % 3) continue;
        const a0 = Math.atan2(s.ty, s.tx);
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = a0 + (k * TAU) / 6;
          const x = s.x + Math.cos(a) * r * 0.7;
          const y = s.y + Math.sin(a) * r * 0.7;
          if (k) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      return;
    case "back_spikes":
      ctx.fillStyle = "rgba(232,234,238,0.85)";
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = Math.max(0.6, r * 0.05);
      for (const s of segs) {
        if (s.i % 2) continue;
        const side = s.i % 4 ? 1 : -1;
        const sway = Math.sin(t * 3 + s.i) * 0.17;
        const c = Math.cos(sway);
        const sn = Math.sin(sway);
        // The outward normal, swung a little.
        const nx0 = -s.ty * side;
        const ny0 = s.tx * side;
        const nx = nx0 * c - ny0 * sn;
        const ny = nx0 * sn + ny0 * c;
        tri(
          ctx,
          s.x + s.tx * r * 0.22,
          s.y + s.ty * r * 0.22,
          s.x - s.tx * r * 0.22,
          s.y - s.ty * r * 0.22,
          s.x + nx * r * 1.1,
          s.y + ny * r * 1.1,
        );
        ctx.fill();
        ctx.stroke();
      }
      return;
    case "chain_links":
      ctx.lineWidth = Math.max(1, r * 0.16);
      for (const s of segs) {
        if (s.i % 2) continue;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r * 0.9, 0, TAU);
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(s.x, s.y, r * 0.9, 0, TAU);
        ctx.strokeStyle = "rgba(205,210,220,0.8)";
        ctx.lineWidth = Math.max(0.6, r * 0.08);
        ctx.stroke();
        ctx.lineWidth = Math.max(1, r * 0.16);
      }
      return;
    case "fin_sail": {
      const fin = segs.filter((s) => s.i >= 3 && s.i <= 12).sort((a, b) => a.i - b.i);
      if (fin.length < 3) return;
      ctx.beginPath();
      fin.forEach((s, k) => {
        const h =
          r * 1.6 * Math.sin((Math.PI * (s.i - 3)) / 9) + Math.sin(t * 4 + s.i / 2) * r * 0.15;
        const x = s.x - s.ty * h;
        const y = s.y + s.tx * h;
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      for (let k = fin.length - 1; k >= 0; k--) ctx.lineTo(fin[k]!.x, fin[k]!.y);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,255,255,0.32)";
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.lineWidth = Math.max(0.8, r * 0.07);
      ctx.stroke();
      return;
    }
    case "lightning_veins": {
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = "#9fd8ff";
      ctx.globalAlpha = 0.45 + Math.sin(t * 20) * 0.3;
      ctx.lineWidth = Math.max(1, r * 0.1);
      ctx.beginPath();
      segs.forEach((s, k) => {
        const off = (jitter(s.i) - 0.5) * r * 0.7;
        const x = s.x - s.ty * off;
        const y = s.y + s.tx * off;
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      return;
    }
    case "molten_cracks":
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = "#ff7a1a";
      ctx.lineWidth = Math.max(1, r * 0.1);
      ctx.lineCap = "round";
      for (const s of segs) {
        if (s.i % 3) continue;
        ctx.globalAlpha = 0.65 + Math.sin(t * 2 + s.i) * 0.25;
        for (let k = 0; k < 3; k++) {
          const a = jitter(s.i, k) * TAU;
          const len = r * (0.35 + jitter(s.i, k + 3) * 0.35);
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x + Math.cos(a) * len, s.y + Math.sin(a) * len);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      return;
    case "leviathan_spines":
      ctx.fillStyle = "#e0323f";
      ctx.strokeStyle = "rgba(40,0,0,0.7)";
      ctx.lineWidth = Math.max(0.6, r * 0.05);
      for (const s of segs) {
        if (s.i % 2) continue;
        const side = s.i % 4 ? 1 : -1;
        const wave = Math.sin(t * 2 + 0.4 * s.i) * 0.25;
        const c = Math.cos(wave);
        const sn = Math.sin(wave);
        const nx0 = -s.ty * side;
        const ny0 = s.tx * side;
        const nx = nx0 * c - ny0 * sn;
        const ny = nx0 * sn + ny0 * c;
        tri(
          ctx,
          s.x + s.tx * r * 0.3,
          s.y + s.ty * r * 0.3,
          s.x - s.tx * r * 0.3,
          s.y - s.ty * r * 0.3,
          s.x + nx * r * 1.4,
          s.y + ny * r * 1.4,
        );
        ctx.fill();
        ctx.stroke();
      }
      return;
    case "bone_segments":
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = Math.max(1, r * 0.09);
      for (const s of segs) {
        const a = Math.atan2(s.ty, s.tx);
        ctx.beginPath();
        ctx.arc(s.x, s.y, r * 0.72, a + Math.PI * 0.55, a + Math.PI * 1.45);
        ctx.stroke();
      }
      return;
    case "crystal_shards":
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = Math.max(0.6, r * 0.05);
      for (const s of segs) {
        if (s.i % 3) continue;
        const side = s.i % 6 ? 1 : -1;
        const glint = Math.sin(t * 5 + s.i) > 0.85 ? 0.95 : 0.6;
        ctx.fillStyle = `rgba(170,220,255,${glint})`;
        const nx = -s.ty * side;
        const ny = s.tx * side;
        tri(
          ctx,
          s.x + s.tx * r * 0.3,
          s.y + s.ty * r * 0.3,
          s.x - s.tx * r * 0.3,
          s.y - s.ty * r * 0.3,
          s.x + nx * r * 1.25,
          s.y + ny * r * 1.25,
        );
        ctx.fill();
        ctx.stroke();
      }
      return;
    case "void_bands":
      for (const s of segs) {
        if (s.i % 2) continue;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r * 0.92, 0, TAU);
        ctx.strokeStyle = "rgba(0,0,0,0.5)";
        ctx.lineWidth = Math.max(1, r * 0.25);
        ctx.stroke();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.18 + Math.sin(t) * 0.08;
        ctx.strokeStyle = "#b56bff";
        ctx.lineWidth = Math.max(1, r * 0.35);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
      return;
    default:
      return;
  }
}

/**
 * Growth armour, from length alone: plates from GROWTH_PLATES, spikes from
 * GROWTH_SPIKES (both hidden by a body piece that covers them); the glow
 * from GROWTH_GLOW is drawn by the renderer along the path (see growthGlow).
 */
export function drawGrowth(
  ctx: CanvasRenderingContext2D,
  mass: number,
  segs: readonly Seg[],
  r: number,
  covered: boolean,
): void {
  if (covered || mass < GROWTH_PLATES) return;
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = Math.max(1, r * 0.22);
  for (const s of segs) {
    if (s.i % 4) continue;
    const a = Math.atan2(s.ty, s.tx);
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 0.78, a + Math.PI * 0.65, a + Math.PI * 1.35);
    ctx.stroke();
  }
  if (mass < GROWTH_SPIKES) return;
  ctx.fillStyle = "rgba(232,234,238,0.75)";
  for (const s of segs) {
    if (s.i % 3) continue;
    const side = s.i % 6 ? 1 : -1;
    const nx = -s.ty * side;
    const ny = s.tx * side;
    tri(
      ctx,
      s.x + s.tx * r * 0.18,
      s.y + s.ty * r * 0.18,
      s.x - s.tx * r * 0.18,
      s.y - s.ty * r * 0.18,
      s.x + nx * r * 0.85,
      s.y + ny * r * 0.85,
    );
    ctx.fill();
  }
}

/** The alpha of the additive body glow earned at GROWTH_GLOW, 0 below it. */
export function growthGlow(mass: number, t: number): number {
  return mass >= GROWTH_GLOW ? 0.14 + Math.sin(t * 2.2) * 0.05 : 0;
}

// ── head ───────────────────────────────────────────────────────────────────────

export function drawHeadItem(
  ctx: CanvasRenderingContext2D,
  id: string,
  x: number,
  y: number,
  r: number,
  angle: number,
  t: number,
  boosting: boolean,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.lineJoin = "round";
  switch (id) {
    case "horn_nubs":
      ctx.fillStyle = "#d8d3c8";
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = Math.max(0.6, r * 0.06);
      for (const side of [-1, 1]) {
        tri(ctx, -0.35 * r, side * 0.6 * r, 0.05 * r, side * 0.85 * r, -0.25 * r, side * 1.3 * r);
        ctx.fill();
        ctx.stroke();
      }
      break;
    case "party_hat": {
      ctx.rotate(0.35);
      const tip = 2 * r;
      const half = 0.55 * r;
      ctx.beginPath();
      ctx.moveTo(0, -half);
      ctx.lineTo(tip, 0);
      ctx.lineTo(0, half);
      ctx.closePath();
      ctx.save();
      ctx.clip();
      const colors = ["#ff5a8a", "#ffd23f", "#3ee0c4"];
      for (let k = 0; k < 6; k++) {
        ctx.fillStyle = colors[k % 3]!;
        ctx.fillRect((k * tip) / 6, -half, tip / 6 + 1, half * 2);
      }
      ctx.restore();
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = Math.max(0.6, r * 0.06);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tip + Math.sin(t * 5) * r * 0.1, 0, r * 0.18, 0, TAU);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      break;
    }
    case "viking_horns":
      ctx.strokeStyle = "#f2e8c9";
      ctx.lineWidth = Math.max(1, r * 0.22);
      ctx.lineCap = "round";
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(0, side * 0.8 * r);
        ctx.quadraticCurveTo(-0.5 * r, side * 1.7 * r, 0.45 * r, side * 1.75 * r);
        ctx.stroke();
      }
      break;
    case "antennae":
      ctx.strokeStyle = "#e8eaee";
      ctx.lineWidth = Math.max(0.8, r * 0.08);
      ctx.lineCap = "round";
      for (const side of [-1, 1]) {
        const wob = Math.sin(t * 6 + side) * r * 0.15;
        ctx.beginPath();
        ctx.moveTo(0.3 * r, side * 0.4 * r);
        ctx.lineTo(1.2 * r + wob, side * 0.95 * r);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(1.2 * r + wob, side * 0.95 * r, r * 0.16, 0, TAU);
        ctx.fillStyle = "#e8eaee";
        ctx.fill();
      }
      break;
    case "devil_horns":
      for (const pass of boosting ? [0, 1] : [0]) {
        if (pass) {
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = 0.5;
        }
        ctx.fillStyle = "#e0323f";
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(-0.3 * r, side * 0.55 * r);
          ctx.quadraticCurveTo(0.1 * r, side * 1.35 * r, 0.65 * r, side * 1.45 * r);
          ctx.quadraticCurveTo(0.05 * r, side * 1.05 * r, 0.1 * r, side * 0.8 * r);
          ctx.closePath();
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
      break;
    case "halo": {
      const bob = Math.sin(t * 2) * r * 0.12;
      for (const pass of [0, 1]) {
        if (pass) {
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = 0.4;
        }
        ctx.beginPath();
        ctx.ellipse(-1.35 * r + bob, 0, r * 0.35, r * 0.8, 0, 0, TAU);
        ctx.strokeStyle = "#f0c14a";
        ctx.lineWidth = Math.max(1, r * (pass ? 0.28 : 0.12));
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
      break;
    }
    case "knight_helm":
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.05, -Math.PI * 0.62, Math.PI * 0.62);
      ctx.strokeStyle = "#b8c0cc";
      ctx.lineWidth = Math.max(1.5, r * 0.36);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.18, -Math.PI * 0.5, Math.PI * 0.5);
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = Math.max(0.6, r * 0.05);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0.9 * r, -0.35 * r);
      ctx.lineTo(0.9 * r, 0.35 * r);
      ctx.strokeStyle = "#101318";
      ctx.lineWidth = Math.max(1, r * 0.12);
      ctx.stroke();
      break;
    case "kabuto":
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.45, Math.PI * 0.6, Math.PI * 1.4);
      ctx.strokeStyle = "#2b2b33";
      ctx.lineWidth = Math.max(2, r * 0.45);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.62, Math.PI * 0.62, Math.PI * 1.38);
      ctx.strokeStyle = "#f0c14a";
      ctx.lineWidth = Math.max(0.8, r * 0.08);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(-1.4 * r, 0, r * 0.32, 0, TAU);
      ctx.fillStyle = "#f0c14a";
      ctx.fill();
      break;
    case "leviathan_fangs": {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.35 + Math.sin(t * 4) * 0.1;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.15, 0, TAU);
      ctx.strokeStyle = "#ff2e4a";
      ctx.lineWidth = Math.max(1, r * 0.3);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      const len = r * (boosting ? 0.72 : 0.65);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.lineWidth = Math.max(0.5, r * 0.04);
      for (const side of [-1, 1]) {
        tri(
          ctx,
          0.75 * r,
          side * 0.5 * r,
          0.75 * r,
          side * 0.2 * r,
          0.75 * r + len,
          side * 0.42 * r,
        );
        ctx.fill();
        ctx.stroke();
      }
      break;
    }
    case "diamond_crown": {
      const color = LEAGUE_COLORS[4] ?? "#7be0ff";
      ctx.beginPath();
      const pts = 5;
      for (let k = 0; k <= pts * 2; k++) {
        const a = -Math.PI + (k * Math.PI) / pts;
        const rr = k % 2 ? r * 1.15 : r * 1.55;
        const x = Math.cos(a) * rr;
        const y = Math.sin(a) * rr;
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, r * 0.12);
      ctx.stroke();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(Math.cos(t * 2) * r * 1.7, Math.sin(t * 2) * r * 1.7, r * 0.14, 0, TAU);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

// ── eyes ───────────────────────────────────────────────────────────────────────

/**
 * The eyes, plain or styled: white discs looking toward `lx, ly` (a unit
 * vector), with pupils that a style can replace (slits, stars, red).
 */
export function drawEyes(
  ctx: CanvasRenderingContext2D,
  id: string | undefined,
  x: number,
  y: number,
  r: number,
  angle: number,
  lx: number,
  ly: number,
  t: number,
): void {
  const ex = Math.cos(angle);
  const ey = Math.sin(angle);
  const px = -ey;
  const py = ex;
  const eye = r * 0.4;
  const pupil = id === "vendetta_eyes" ? "#ff2e4a" : "#101318";
  for (const side of [-1, 1]) {
    const cx = x + ex * r * 0.36 + px * side * r * 0.5;
    const cy = y + ey * r * 0.36 + py * side * r * 0.5;
    ctx.beginPath();
    ctx.arc(cx, cy, eye, 0, TAU);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, eye, 0, TAU);
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = Math.max(0.6, r * 0.06);
    ctx.stroke();
    const qx = cx + lx * eye * 0.4;
    const qy = cy + ly * eye * 0.4;
    ctx.fillStyle = pupil;
    if (id === "cat_eyes") {
      ctx.beginPath();
      ctx.ellipse(qx, qy, eye * 0.18, eye * 0.62, angle, 0, TAU);
      ctx.fill();
    } else if (id === "star_eyes") {
      const k = eye * (0.55 + Math.sin(t * 6) * 0.06);
      ctx.beginPath();
      for (let n = 0; n < 8; n++) {
        const a = angle + (n * Math.PI) / 4;
        const rr = n % 2 ? k * 0.42 : k;
        const sx = qx + Math.cos(a) * rr;
        const sy = qy + Math.sin(a) * rr;
        if (n) ctx.lineTo(sx, sy);
        else ctx.moveTo(sx, sy);
      }
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(qx, qy, eye * 0.5, 0, TAU);
      ctx.fill();
    }
    if (id === "vendetta_eyes") {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.25 + Math.sin(t * 3) * 0.12;
      ctx.beginPath();
      ctx.arc(cx, cy, eye * 1.1, 0, TAU);
      ctx.fillStyle = "#ff2e4a";
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.beginPath();
    ctx.arc(
      cx + lx * eye * 0.25 - eye * 0.18,
      cy + ly * eye * 0.25 - eye * 0.22,
      eye * 0.16,
      0,
      TAU,
    );
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fill();
  }
  if (id === "angry_brows") {
    // A pale edge under the dark stroke, so the brows read on a dark head.
    ctx.lineCap = "round";
    for (const [color, width] of [
      ["rgba(255,255,255,0.7)", 0.22],
      ["#101318", 0.12],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, r * width);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(
          x + ex * r * 0.2 + px * side * r * 0.95,
          y + ey * r * 0.2 + py * side * r * 0.95,
        );
        ctx.lineTo(
          x + ex * r * 0.75 + px * side * r * 0.45,
          y + ey * r * 0.75 + py * side * r * 0.45,
        );
        ctx.stroke();
      }
    }
  } else if (id === "cyber_visor") {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = "rgba(0,220,255,0.35)";
    ctx.fillRect(0.05 * r, -0.98 * r, 0.75 * r, 1.96 * r);
    ctx.strokeStyle = "rgba(0,220,255,0.7)";
    ctx.lineWidth = Math.max(0.6, r * 0.05);
    ctx.strokeRect(0.05 * r, -0.98 * r, 0.75 * r, 1.96 * r);
    const scan = -0.98 * r + (t % 1) * 1.96 * r;
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "rgba(180,255,255,0.8)";
    ctx.fillRect(0.05 * r, scan, 0.75 * r, Math.max(1, r * 0.08));
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  }
}

// ── aura ───────────────────────────────────────────────────────────────────────

const auraGradients = new Map<string, CanvasGradient>();

/** A radial gradient from `inner` to `outer` radius in a colour, cached per radius bucket. */
function glow(
  ctx: CanvasRenderingContext2D,
  key: string,
  r: number,
  inner: number,
  outer: number,
  rgb: string,
  alpha: number,
): CanvasGradient {
  const bucket = Math.round(r);
  const k = `${key}:${bucket}:${alpha.toFixed(2)}`;
  let g = auraGradients.get(k);
  if (!g) {
    g = ctx.createRadialGradient(0, 0, bucket * inner, 0, 0, bucket * outer);
    g.addColorStop(0, `rgba(${rgb},${alpha})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    if (auraGradients.size > 256) auraGradients.clear();
    auraGradients.set(k, g);
  }
  return g;
}

export function drawAuraItem(
  ctx: CanvasRenderingContext2D,
  id: string,
  x: number,
  y: number,
  r: number,
  t: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  switch (id) {
    case "ember_glow": {
      const a = 0.22 + Math.sin(t) * 0.08;
      ctx.fillStyle = glow(ctx, id, r, 1.2, 2.4, "255,122,26", Math.round(a * 20) / 20);
      ctx.fillRect(-r * 2.4, -r * 2.4, r * 4.8, r * 4.8);
      break;
    }
    case "frost_ring":
      ctx.beginPath();
      ctx.arc(0, 0, r * 2, 0, TAU);
      ctx.strokeStyle = "rgba(191,233,255,0.6)";
      ctx.lineWidth = Math.max(1, r * 0.12);
      ctx.stroke();
      ctx.fillStyle = "#e8f7ff";
      for (let k = 0; k < 6; k++) {
        const a = t * 0.5 + (k * TAU) / 6;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r * 2, Math.sin(a) * r * 2, r * 0.13, 0, TAU);
        ctx.fill();
      }
      break;
    case "storm_cloud":
      ctx.strokeStyle = "rgba(160,170,190,0.55)";
      ctx.lineWidth = Math.max(1.5, r * 0.3);
      ctx.lineCap = "round";
      for (let k = 0; k < 3; k++) {
        const a = t * 0.9 + (k * TAU) / 3;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.9, a, a + 1.2);
        ctx.stroke();
      }
      if (Math.sin(t * 7) > 0.995) {
        ctx.beginPath();
        ctx.arc(0, 0, r * 2.2, 0, TAU);
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.fill();
      }
      break;
    case "leviathan_dread": {
      ctx.fillStyle = glow(ctx, id, r, 1.1, 2.4, "224,50,63", 0.35);
      ctx.fillRect(-r * 2.4, -r * 2.4, r * 4.8, r * 4.8);
      const f = t % 1;
      ctx.beginPath();
      ctx.arc(0, 0, r * (1.2 + f * 1.8), 0, TAU);
      ctx.strokeStyle = `rgba(255,90,110,${(1 - f) * 0.5})`;
      ctx.lineWidth = Math.max(1, r * 0.15);
      ctx.stroke();
      break;
    }
    case "platinum_sheen": {
      ctx.fillStyle = glow(ctx, id, r, 1.1, 2.3, "220,226,236", 0.3);
      ctx.fillRect(-r * 2.3, -r * 2.3, r * 4.6, r * 4.6);
      const a = t * 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.9, a, a + 0.9);
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = Math.max(1, r * 0.2);
      ctx.lineCap = "round";
      ctx.stroke();
      break;
    }
    case "sun_halo":
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = "#f0c14a";
      for (let k = 0; k < 8; k++) {
        const a = t * 0.3 + (k * TAU) / 8;
        const c = Math.cos(a);
        const s = Math.sin(a);
        tri(
          ctx,
          c * r * 1.3 - s * r * 0.12,
          s * r * 1.3 + c * r * 0.12,
          c * r * 1.3 + s * r * 0.12,
          s * r * 1.3 - c * r * 0.12,
          c * r * 2.3,
          s * r * 2.3,
        );
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      break;
    default:
      break;
  }
  ctx.restore();
}

// ── name ───────────────────────────────────────────────────────────────────────

/** How a name style dresses the tag; null for a plain tag. */
export function nameStyle(id: string | undefined, t: number): NameStyle | null {
  switch (id) {
    case "shadow_name":
      return { outline: "rgba(0,0,0,0.95)" };
    case "neon_name":
      return { color: "#6ff5ff", glow: "#00e5ff" };
    case "gold_name":
      return { color: "#f0c14a", glyph: "♛" };
    case "rainbow_name":
      return { color: `hsl(${Math.floor((t * 60) % 360)}, 90%, 68%)` };
    case "frost_name":
      return { color: "#bfe9ff", glyph: "❄" };
    case "royal_name":
      return { color: "#d9b3ff", glyph: "♛", bg: "rgba(40,16,70,0.85)" };
    case "slayer_name":
      return { color: "#ff6b6b", glyph: "☠", border: "#ff5a6e" };
    default:
      return null;
  }
}
