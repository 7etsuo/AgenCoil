/**
 * League crests. One silhouette per tier with its letter inside, drawn the
 * same way on the canvas (the frame around a head, the crest in a tag, the
 * share card) and, through `components/crest.tsx`, in the UI. The shapes
 * differ by feature, not only by colour: no corners, four corners, a flat
 * top over a point, points at the sides, a girdle over a point.
 */
import { LEAGUE_COLORS, LEAGUE_LETTERS, LEAGUE_SHAPES, type LeagueShape } from "./challenges";

export const CREST_INK = "#06080e";
export const CREST_OUTLINE = "rgba(6,8,14,0.6)";

type Pt = readonly [number, number];

/** Corners of the polygon crests in a unit square centred on the origin, clockwise from the top left. */
const POLYGONS: Partial<Record<LeagueShape, readonly Pt[]>> = {
  shield: [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.1],
    [0, 0.5],
    [-0.5, 0.1],
  ],
  hexagon: [
    [-0.25, -0.5],
    [0.25, -0.5],
    [0.5, 0],
    [0.25, 0.5],
    [-0.25, 0.5],
    [-0.5, 0],
  ],
  gem: [
    [-0.28, -0.5],
    [0.28, -0.5],
    [0.5, -0.1],
    [0, 0.5],
    [-0.5, -0.1],
  ],
};

/** The polygon of a crest in unit coordinates, or null for the circle and the square. */
export function crestPolygon(shape: LeagueShape): readonly Pt[] | null {
  return POLYGONS[shape] ?? null;
}

/** Where the letter sits: the pointed shapes carry their weight high, so it rides a little above centre. */
export function crestLetterOffset(shape: LeagueShape): number {
  return shape === "shield" || shape === "gem" ? -0.06 : 0;
}

/** Trace a crest's outline, `size` wide and tall, centred on (x, y). The caller fills or strokes. */
export function crestPath(
  ctx: CanvasRenderingContext2D,
  shape: LeagueShape,
  x: number,
  y: number,
  size: number,
): void {
  ctx.beginPath();
  if (shape === "circle") {
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    return;
  }
  if (shape === "square") {
    const h = size / 2;
    const rr = size * 0.06;
    const l = x - h;
    const t = y - h;
    const rt = x + h;
    const b = y + h;
    ctx.moveTo(l + rr, t);
    ctx.arcTo(rt, t, rt, b, rr);
    ctx.arcTo(rt, b, l, b, rr);
    ctx.arcTo(l, b, l, t, rr);
    ctx.arcTo(l, t, rt, t, rr);
    ctx.closePath();
    return;
  }
  const pts = POLYGONS[shape]!;
  ctx.moveTo(x + pts[0]![0] * size, y + pts[0]![1] * size);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(x + pts[i]![0] * size, y + pts[i]![1] * size);
  ctx.closePath();
}

/**
 * A filled crest with its letter: the tier mark as drawn in a tag, the HUD
 * and the share card. `tier` is 1 Bronze to 5 Diamond; 0 draws nothing.
 * Leaves the font, alignment and baseline changed; callers reset their own.
 */
export function drawCrest(
  ctx: CanvasRenderingContext2D,
  tier: number,
  x: number,
  y: number,
  size: number,
): void {
  const i = tier - 1;
  const shape = LEAGUE_SHAPES[i];
  if (!shape) return;
  crestPath(ctx, shape, x, y, size);
  ctx.fillStyle = LEAGUE_COLORS[i]!;
  ctx.fill();
  ctx.strokeStyle = CREST_OUTLINE;
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";
  ctx.stroke();
  if (shape === "gem") {
    ctx.beginPath();
    ctx.moveTo(x - size / 2, y - size * 0.1);
    ctx.lineTo(x + size / 2, y - size * 0.1);
    ctx.strokeStyle = CREST_INK;
    ctx.stroke();
  }
  const fs = size * 0.62;
  ctx.font = `700 ${fs}px Outfit, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = CREST_INK;
  ctx.fillText(LEAGUE_LETTERS[i]!, x, y + size * crestLetterOffset(shape) + fs * 0.06);
}
