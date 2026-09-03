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

/**
 * Cosmetic ids. Trails 1..3 and death effects 1..2 come from challenges;
 * trails 4..5 and death effects 3..4 come from streak milestones.
 */
export const TRAILS = ["none", "sparks", "ember", "rainbow", "frost", "void"] as const;
export const DEATH_FX = ["pop", "ring", "shatter", "nova", "confetti"] as const;
export const UNLOCK_TRAIL = [0, 1, 2, 4, 32, 128] as const; // bit per trail id
export const UNLOCK_DEATH = [0, 8, 16, 64, 256] as const; // bit per death fx id

/** Daily streak milestones and the unlock bit each grants. */
export const STREAK_MILESTONES: { days: number; unlock: number; label: string }[] = [
  { days: 3, unlock: 32, label: "frost trail" },
  { days: 7, unlock: 64, label: "nova death" },
  { days: 14, unlock: 128, label: "void trail" },
  { days: 30, unlock: 256, label: "confetti death" },
];
/** Games played per earned streak freeze; at most one banked. */
export const FREEZE_EVERY_GAMES = 5;

/** Weekly leagues by weekly best length. */
export const LEAGUES = [
  { name: "Bronze", min: 0 },
  { name: "Silver", min: 300 },
  { name: "Gold", min: 800 },
  { name: "Platinum", min: 1500 },
  { name: "Diamond", min: 3000 },
] as const;

export function leagueOf(weekBest: number): number {
  let tier = 0;
  LEAGUES.forEach((l, i) => {
    if (weekBest >= l.min) tier = i;
  });
  return tier;
}

/** Evolution level from total length eaten across all runs. */
export function levelOf(eaten: number): number {
  return Math.floor(Math.sqrt(Math.max(0, eaten) / 300));
}

/** Titles earned from lifetime stats, shown next to a name. */
export function titleOf(p: {
  kills: number;
  survive: number;
  nearTotal: number;
  bountyTotal: number;
}): string {
  if (p.bountyTotal >= 3) return "Bounty Hunter";
  if (p.nearTotal >= 200) return "Untouchable";
  if (p.kills >= 50) return "Hunter";
  if (p.survive >= 600) return "Survivor";
  return "";
}

/** Hourly arena modes: active for the first 15 minutes of every hour. */
export const MODES = [
  { id: 1, name: "double remains", text: "Remains are worth twice as much" },
  { id: 3, name: "hunger", text: "Length drains slowly, keep eating" },
  { id: 4, name: "tiny", text: "No comebacks, everyone starts fresh" },
] as const;
export const MODE_MINUTES = 15;

export function modeNow(now = Date.now()): { id: number; secsLeft: number; secsToNext: number } {
  const d = new Date(now);
  const minute = d.getUTCMinutes();
  const sec = d.getUTCSeconds();
  const hourIndex = Math.floor(now / 3_600_000);
  const active = minute < MODE_MINUTES;
  const id = active ? MODES[hourIndex % MODES.length]!.id : 0;
  const secsLeft = active ? (MODE_MINUTES - minute) * 60 - sec : 0;
  const secsToNext = active ? 0 : (60 - minute) * 60 - sec;
  return { id, secsLeft, secsToNext };
}

/** Six-week seasons counted from an epoch. */
const SEASON_EPOCH = Date.UTC(2026, 8, 7); // Monday 2026-09-07
const SEASON_MS = 6 * 7 * 86_400_000;
export function seasonOf(now = Date.now()): number {
  return Math.max(1, Math.floor((now - SEASON_EPOCH) / SEASON_MS) + 1);
}
export function seasonEndsAt(now = Date.now()): number {
  return SEASON_EPOCH + seasonOf(now) * SEASON_MS;
}

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

/** ISO week id like 2026-W36, for weekly bests and the weekly skin. */
export function isoWeek(d = new Date()): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Limited skins: one per week, earned by finishing three challenges that week. */
export const WEEKLY_SKINS: { name: string; bands: string[] }[] = [
  { name: "aurora", bands: ["#3ee0c4", "#6ea8ff", "#d45dff", "#3ee0c4", "#07090f"] },
  { name: "magma", bands: ["#ff6b3d", "#2a0d05", "#ffb347", "#2a0d05"] },
  { name: "tide", bands: ["#0b3a5c", "#5ad0e8", "#ffffff", "#5ad0e8"] },
  { name: "hornet", bands: ["#f0c14a", "#111318", "#f0c14a", "#111318", "#ffffff"] },
  { name: "orchid", bands: ["#e45fa0", "#5b2a6e", "#ffd0e7"] },
  { name: "circuit", bands: ["#7dcf6a", "#0c1a10", "#0c1a10", "#f7f3a6"] },
];

export const WEEKLY_GOAL = 3;

export function weeklySkinFor(week: string): { name: string; bands: string[] } {
  let h = 0;
  for (const ch of week) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return WEEKLY_SKINS[h % WEEKLY_SKINS.length]!;
}
