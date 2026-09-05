/**
 * The character level: permanent, earned across lives, never lost. Shared by
 * the server, which books every point, and the client, which draws the bar.
 * The table is shaped like an MMO's: each level costs more than the last,
 * the cap is a long way off, and one life can never jump levels because
 * growth pays on a concave curve.
 */

export const LEVEL_CAP = 60;

/** XP needed to go from `level` to the next; 0 at the cap. */
export function xpToNext(level: number): number {
  if (!(level >= 1) || level >= LEVEL_CAP) return 0;
  return Math.round(100 * Math.pow(level, 1.8));
}

/** Total XP at which each level begins: XP_TABLE[1] is 0, XP_TABLE[2] is 100. */
const XP_TABLE: number[] = [0, 0];
for (let level = 1; level < LEVEL_CAP; level++)
  XP_TABLE[level + 1] = XP_TABLE[level]! + xpToNext(level);

/** XP at the cap; nothing is booked past it. */
export const XP_MAX = XP_TABLE[LEVEL_CAP]!;

/** Total XP at which `level` begins. */
export function xpForLevel(level: number): number {
  const l = Math.max(1, Math.min(LEVEL_CAP, Math.floor(level)));
  return XP_TABLE[l]!;
}

export function levelOf(xp: number): number {
  const v = Math.max(0, xp);
  let level = 1;
  while (level < LEVEL_CAP && v >= XP_TABLE[level + 1]!) level++;
  return level;
}

/** Where `xp` sits: the level, XP into it, and the level's whole cost (0 at the cap). */
export function xpInto(xp: number): { level: number; into: number; next: number } {
  const level = levelOf(xp);
  return { level, into: Math.max(0, Math.floor(xp)) - XP_TABLE[level]!, next: xpToNext(level) };
}

/** A kill pays 25 plus twice the square root of the victim's length, at most this. */
export const XP_KILL_MAX = 125;
export const XP_CONTRACT = 60;
export const XP_MARK = 30;
/** Per cut or ram on the boss, for at most this many per boss; the final blow; every other participant. */
export const XP_BOSS_HIT = 15;
export const XP_BOSS_HITS_MAX = 10;
export const XP_BOSS_KILL = 500;
export const XP_BOSS_PART = 150;
export const XP_QUEST = 100;
export const XP_CHEST = 50;
export const XP_ACHIEVEMENT = 100;
/** The first life of a UTC day. */
export const XP_DAILY = 100;
/** Rested XP accrues while away: this share of the current level's cost per hour, up to one level. */
export const RESTED_PER_HOUR = 0.05;

/**
 * Growth XP for the length gained in one life: 5 times gained to the 0.6.
 * A longer life always pays more, but ten times the length pays about four
 * times the XP, so one run cannot jump levels. Floored, so it can be booked
 * incrementally as the peak rises and still sum to the closed form.
 */
export function growthXp(gained: number): number {
  return Math.floor(5 * Math.pow(Math.max(0, gained), 0.6));
}

export function killXp(victimLength: number): number {
  return Math.min(XP_KILL_MAX, Math.floor(25 + 2 * Math.sqrt(Math.max(0, victimLength))));
}

/** Rested XP earned by `hoursAway` at `level`, capped at one level's cost. */
export function restedFor(level: number, hoursAway: number): number {
  const next = xpToNext(level);
  return Math.min(next, Math.floor(Math.max(0, hoursAway) * RESTED_PER_HOUR * next));
}

/** Scales paid for reaching a level. */
export function scalesForLevel(level: number): number {
  return 25 + level;
}
export const SCALES_QUEST = 50;
export const SCALES_CHEST = 100;
export const SCALES_BOSS = 50;

/** Scales a life pays at its end. */
export function lifeScales(s: {
  length: number;
  kills: number;
  contracts?: number;
  marks?: number;
}): number {
  return (
    Math.floor(Math.max(0, s.length) / 50) +
    10 * s.kills +
    15 * (s.contracts ?? 0) +
    10 * (s.marks ?? 0)
  );
}

/**
 * The one-time seed from lifetime totals for profiles that existed before
 * levels: the growth formula applied to the average life, kills, feats and
 * chests. `SEED_XP_SQL` is the same arithmetic for the migration statement.
 */
export function seedXp(t: {
  games: number;
  eaten: number;
  kills: number;
  achievements: number;
  chests: number;
}): number {
  if (!(t.games > 0)) return 0;
  const avg = Math.max(0, t.eaten) / t.games;
  return Math.min(
    XP_MAX,
    Math.floor(
      t.games * 5 * Math.pow(avg, 0.6) + 25 * t.kills + 100 * t.achievements + 50 * t.chests,
    ),
  );
}
export const SEED_XP_SQL =
  "LEAST($1::float8, FLOOR(games * 5 * POWER(GREATEST(eaten, 0)::float8 / GREATEST(games, 1), 0.6) " +
  "+ 25 * kills + 100 * cardinality(ARRAY(SELECT jsonb_object_keys(achv))) + 50 * chests))::bigint";

/** Notice kinds: the life's XP line for the death card, and a level reached. */
export const NOTICE_XP = 17;
export const NOTICE_LEVEL = 18;
