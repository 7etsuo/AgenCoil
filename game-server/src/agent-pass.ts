/**
 * A pass for the owner's own headless clients (the trained agents in rl/):
 * `?agent=<timestamp>.<signature>` on the socket URL, signed with the game
 * secret. A socket carrying a valid pass is exempt from the per-address
 * connection caps and the human-verification gate, nothing else. The
 * signature covers the timestamp, and a pass is honoured for a day.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const AGENT_PASS_MS = 24 * 3600_000;

export function mintAgentPass(secret: string, now = Date.now()): string {
  return `${now}.${createHmac("sha256", secret).update(`agent:${now}`).digest("base64url")}`;
}

export function checkAgentPass(pass: string | null, secret: string, now = Date.now()): boolean {
  if (!pass || !secret) return false;
  const dot = pass.indexOf(".");
  if (dot < 1) return false;
  const ts = Number(pass.slice(0, dot));
  if (!Number.isFinite(ts) || Math.abs(now - ts) > AGENT_PASS_MS) return false;
  const a = Buffer.from(pass.slice(dot + 1));
  const b = Buffer.from(createHmac("sha256", secret).update(`agent:${ts}`).digest("base64url"));
  return a.length === b.length && timingSafeEqual(a, b);
}
