/**
 * Contracts: the objective inside a life. Every so often the arena hands a
 * live snake a target and a clock ("hunt viper · 0:58 · +260"); taking the
 * target down in time pays the reward on top of the remains and grows a
 * streak that raises the next reward. A player who is hunted gets the
 * mirror ("marked by tetsuo · survive 0:58 · +150") and is paid for
 * outliving the clock. Targets are near, of comparable size, never rookies,
 * never party mates; with few players about they are bots, so the loop
 * never goes quiet. Shared by the server (which runs it) and the client
 * (which shows it); kept import-free like challenges.ts.
 */

/** No contract in the first half minute of a life. */
export const CONTRACT_FIRST_MS = 30_000;
/** The pause between the end of one contract and the next offer. */
export const CONTRACT_GAP_MS = 45_000;
/** A target is within this many units when the contract is offered. */
export const CONTRACT_RANGE = 2600;
export const CONTRACT_MIN_S = 45;
export const CONTRACT_MAX_S = 90;
/** Neither a hunter nor a target is ever shorter than this. */
export const CONTRACT_MIN_MASS = 40;
/** A target is between these multiples of the hunter's length. */
export const CONTRACT_RATIO_MIN = 0.3;
export const CONTRACT_RATIO_MAX = 2.5;
/** Each contract done in a row adds this much to the next reward, up to the cap. */
export const CONTRACT_STREAK_STEP = 0.15;
export const CONTRACT_STREAK_MAX = 6;
export const CONTRACT_REWARD_CAP = 2000;
/** The marked player's reward for surviving, as a share of the hunter's. */
export const MARK_REWARD_RATIO = 0.6;

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

/** How long a contract runs: 45 s, plus a second per 60 units of distance, at most 90 s. */
export function contractSecs(dist: number): number {
  return Math.round(clamp(CONTRACT_MIN_S + dist / 60, CONTRACT_MIN_S, CONTRACT_MAX_S));
}

/** Length paid for filling a contract: a share of the target, grown by the streak. */
export function contractReward(targetMass: number, streak: number): number {
  const base = clamp(targetMass * 0.3, 60, 1200);
  const mult = 1 + CONTRACT_STREAK_STEP * clamp(streak, 0, CONTRACT_STREAK_MAX);
  return Math.min(CONTRACT_REWARD_CAP, Math.round(base * mult));
}

/** Length paid to the marked player for outliving the clock. */
export function markReward(huntReward: number): number {
  return Math.round(huntReward * MARK_REWARD_RATIO);
}

/** Is a target a fair contract for a hunter of this length? */
export function contractFair(hunterMass: number, targetMass: number): boolean {
  return (
    hunterMass >= CONTRACT_MIN_MASS &&
    targetMass >= CONTRACT_MIN_MASS &&
    targetMass >= hunterMass * CONTRACT_RATIO_MIN &&
    targetMass <= hunterMass * CONTRACT_RATIO_MAX
  );
}
