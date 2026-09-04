/**
 * Afterlife wisp movement, shared by the client (prediction) and the server
 * (the rim). The wisp is steered like a head: the aim gives a direction, the
 * heading turns toward it at a bounded rate, and with no live input the wisp
 * flies on. It can never be "reached", so it never stalls or jitters at a
 * point, and the rim turns it along the wall instead of pinning it.
 */
import { ARENA_RADIUS, WISP_BOOST, WISP_RIM_MARGIN, WISP_SPEED, clamp, wrapAngle } from "./model";

/** Radians per second the wisp can turn: a half turn in about half a second. */
export const WISP_TURN = 6;
/** An aim point closer than this to the wisp is no direction at all. */
export const WISP_AIM_DEAD = 12;

export interface WispState {
  x: number;
  y: number;
  angle: number;
}

/**
 * Turn `w` toward `aim` (a world point) at the bounded rate. Only called for
 * a live aim: a released key leaves a stale point the wisp may already have
 * passed, and turning toward that is what made it flip back and forth.
 */
export function steerWisp(w: WispState, aim: { x: number; y: number }, dt: number): void {
  const ax = aim.x - w.x;
  const ay = aim.y - w.y;
  if (Math.hypot(ax, ay) <= WISP_AIM_DEAD) return;
  const maxTurn = WISP_TURN * dt;
  const delta = wrapAngle(Math.atan2(ay, ax) - w.angle);
  w.angle = wrapAngle(w.angle + clamp(delta, -maxTurn, maxTurn));
}

/** Fly one step along the heading. */
export function moveWisp(w: WispState, boosting: boolean, dt: number): void {
  const sp = boosting ? WISP_BOOST : WISP_SPEED;
  w.x += Math.cos(w.angle) * sp * dt;
  w.y += Math.sin(w.angle) * sp * dt;
}

/**
 * Keep the wisp inside the rim. A heading into the wall becomes the nearer
 * tangent, so the wisp slides along the edge instead of sitting pinned on it.
 */
export function slideAlongRim(w: WispState, lim = ARENA_RADIUS - WISP_RIM_MARGIN): void {
  const d = Math.hypot(w.x, w.y);
  if (d <= lim) return;
  w.x *= lim / d;
  w.y *= lim / d;
  const out = Math.atan2(w.y, w.x);
  const rel = wrapAngle(w.angle - out);
  if (Math.abs(rel) < Math.PI / 2) w.angle = wrapAngle(out + (rel < 0 ? -1 : 1) * (Math.PI / 2));
}
