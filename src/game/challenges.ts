/**
 * Daily challenges, shared by server (progress) and client (text). Three are
 * picked per UTC day from the pool, deterministically, so every player sees
 * the same set. Each completed challenge unlocks one cosmetic.
 */
export type ChallengeKind =
  "length" | "kills" | "survive" | "near" | "remains" | "noboost" | "bounty";

export interface Challenge {
  id: number;
  kind: ChallengeKind;
  target: number;
  text: string;
  /** Cosmetic unlocked on completion: a bit in the profile's unlock mask. */
  unlock: number;
}

/** Cosmetic ids. Trails 1..3 and death effects 1..2 map to unlock bits. */
export const TRAILS = ["none", "sparks", "ember", "rainbow"] as const;
export const DEATH_FX = ["pop", "ring", "shatter"] as const;
export const UNLOCK_TRAIL = [0, 1, 2, 4] as const; // bit per trail id
export const UNLOCK_DEATH = [0, 8, 16] as const; // bit per death fx id

const POOL: Omit<Challenge, "id">[] = [
  { kind: "length", target: 300, text: "Reach length 300", unlock: 1 },
  { kind: "kills", target: 3, text: "Take down 3 snakes in one life", unlock: 2 },
  { kind: "survive", target: 300, text: "Survive 5 minutes in one life", unlock: 4 },
  { kind: "near", target: 10, text: "Land 10 close calls in one life", unlock: 8 },
  { kind: "remains", target: 400, text: "Eat 400 length of remains in one life", unlock: 16 },
  { kind: "noboost", target: 200, text: "Reach length 200 without boosting", unlock: 2 },
  { kind: "bounty", target: 1, text: "Claim a bounty", unlock: 16 },
  { kind: "length", target: 1000, text: "Reach length 1000", unlock: 4 },
  { kind: "kills", target: 1, text: "Take down a snake", unlock: 1 },
  { kind: "near", target: 25, text: "Land 25 close calls in one life", unlock: 8 },
];

function seed(day: string): number {
  let h = 2166136261;
  for (const ch of day) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** The three challenges for a UTC day string (YYYY-MM-DD). */
export function dailyChallenges(day: string): Challenge[] {
  let s = seed(day);
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const picked = new Set<number>();
  while (picked.size < 3) {
    const i = Math.floor(next() * POOL.length);
    // Avoid two of the same kind in one day.
    if ([...picked].some((p) => POOL[p]!.kind === POOL[i]!.kind)) continue;
    picked.add(i);
  }
  return [...picked].map((i) => ({ id: i, ...POOL[i]! }));
}

/** What one life produced, for challenge progress. */
export interface LifeStats {
  length: number;
  kills: number;
  survive: number;
  near: number;
  remains: number;
  noboostLength: number;
  bounty: number;
}

export function lifeValue(c: Challenge, life: LifeStats): number {
  switch (c.kind) {
    case "length":
      return life.length;
    case "kills":
      return life.kills;
    case "survive":
      return life.survive;
    case "near":
      return life.near;
    case "remains":
      return life.remains;
    case "noboost":
      return life.noboostLength;
    case "bounty":
      return life.bounty;
  }
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
