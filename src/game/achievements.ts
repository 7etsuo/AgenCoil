/**
 * Achievements: lifetime milestones and single-life feats.
 *
 * Shared by the server (which awards them at the end of a life and keeps
 * them on the profile) and the client (which shows progress toward the next
 * ones from the totals PROFILE already carries). Ids are stable strings and
 * are what the wire and the database store; never renumber them.
 */
import type { LifeStats } from "./challenges";

/** Lifetime totals every milestone is measured against. */
export interface Totals {
  best: number;
  kills: number;
  games: number;
  survive: number;
  eaten: number;
  nearTotal: number;
  bountyTotal: number;
  streak: number;
  chests: number;
}

export interface Achievement {
  id: string;
  /** Display name; tiers share a group name with a roman numeral. */
  name: string;
  desc: string;
  icon: string;
  /** "total": a lifetime threshold on a Totals field. "feat": awarded by the server. */
  kind: "total" | "feat";
  stat?: keyof Totals;
  target?: number;
  /** Tiers of one group share this; the UI collapses them to the highest reached. */
  group: string;
  tier: number;
}

const ROMAN = ["", "I", "II", "III", "IV", "V"];

function tiers(
  group: string,
  name: string,
  icon: string,
  stat: keyof Totals,
  unit: string,
  targets: number[],
): Achievement[] {
  return targets.map((target, i) => ({
    id: `${group}_${i + 1}`,
    name: targets.length > 1 ? `${name} ${ROMAN[i + 1]}` : name,
    desc: `${unit.replace("%d", String(target))}`,
    icon,
    kind: "total",
    stat,
    target,
    group,
    tier: i + 1,
  }));
}

function feat(id: string, name: string, desc: string, icon: string): Achievement {
  return { id, name, desc, icon, kind: "feat", group: id, tier: 1 };
}

export const ACHIEVEMENTS: readonly Achievement[] = [
  {
    ...feat("first_blood", "First Blood", "your first kill", "🩸"),
    kind: "total",
    stat: "kills",
    target: 1,
  },
  ...tiers("hunter", "Hunter", "🎯", "kills", "%d kills all time", [10, 50, 250, 1000]),
  ...tiers("big", "Big Snek", "🐍", "best", "reach length %d", [100, 300, 1000, 3000]),
  ...tiers("glutton", "Glutton", "🍩", "eaten", "eat %d length all time", [1000, 10000, 100000]),
  ...tiers(
    "survivor",
    "Survivor",
    "⏱️",
    "survive",
    "stay alive %d seconds in one life",
    [120, 300, 600, 1200],
  ),
  ...tiers("regular", "Regular", "🎮", "games", "play %d lives", [10, 100, 1000]),
  ...tiers(
    "untouchable",
    "Untouchable",
    "💨",
    "nearTotal",
    "%d near misses all time",
    [25, 200, 1000],
  ),
  ...tiers("bounty", "Bounty Hunter", "💰", "bountyTotal", "claim %d bounties", [1, 3, 10]),
  ...tiers("streak", "On Fire", "🔥", "streak", "a %d day streak", [3, 7, 30]),
  ...tiers("collector", "Collector", "🎁", "chests", "open %d chests", [1, 5, 20]),
  feat("pentakill", "Pentakill", "five kills in one life", "⚔️"),
  feat("rampage", "Rampage", "ten kills in one life", "🔥"),
  feat("pacifist", "Pacifist", "reach 500 without a single kill", "🕊️"),
  feat("purist", "Purist", "reach 300 without ever boosting", "🧘"),
  feat("scavenger", "Scavenger", "eat 500 of remains in one life", "🦴"),
  feat("marathon", "Marathon", "fifteen minutes alive in one life", "🏃"),
  feat("afterlife", "Afterlife", "fill the wisp bank", "👻"),
  feat("comeback", "Comeback Kid", "take the comeback respawn", "💪"),
  feat("boss_slayer", "Boss Slayer", "land the final cut on the boss", "👑"),
  feat("linked", "Signed In", "link your X account", "✕"),
  feat("league_silver", "Silver Week", "bank a Silver finish in one week", "🥈"),
  feat("league_gold", "Gold Week", "bank a Gold finish in one week", "🥇"),
  feat("league_platinum", "Platinum Week", "bank a Platinum finish in one week", "💠"),
  feat("league_diamond", "Diamond Week", "bank a Diamond finish in one week", "💎"),
  feat("season_gold", "Season Gold", "finish a season in Gold or better", "🏅"),
  feat("season_diamond", "Season Diamond", "finish a season in Diamond", "👑"),
  feat("payback", "Payback", "take down your nemesis", "⚔️"),
];

/** The feat for banking a weekly tier, by tier (1 Bronze to 5 Diamond); Bronze has none. */
export const LEAGUE_FEATS: readonly string[] = [
  "",
  "league_silver",
  "league_gold",
  "league_platinum",
  "league_diamond",
];

/** Feats for a season finish at or above a tier. */
export function seasonFeats(tier: number): string[] {
  const out: string[] = [];
  if (tier >= 3) out.push("season_gold");
  if (tier >= 5) out.push("season_diamond");
  return out;
}

export const ACHIEVEMENT_BY_ID: ReadonlyMap<string, Achievement> = new Map(
  ACHIEVEMENTS.map((a) => [a.id, a]),
);

/** Might is achievements unlocked; it shows as this many pips at most. */
export const MIGHT_PIPS = 5;

/** Pips for a might count: none at zero, at least one once anything is unlocked. */
export function mightPips(count: number): number {
  if (count <= 0) return 0;
  return Math.max(1, Math.min(MIGHT_PIPS, Math.round((MIGHT_PIPS * count) / ACHIEVEMENTS.length)));
}

/** Ids of every lifetime milestone the totals satisfy. */
export function totalsUnlocked(t: Totals): string[] {
  const out: string[] = [];
  for (const a of ACHIEVEMENTS) {
    if (a.kind !== "total" || !a.stat || a.target === undefined) continue;
    if (t[a.stat] >= a.target) out.push(a.id);
  }
  return out;
}

/** Feats a single life earns on its own. */
export function lifeFeats(life: LifeStats): string[] {
  const out: string[] = [];
  if (life.kills >= 5) out.push("pentakill");
  if (life.kills >= 10) out.push("rampage");
  if (life.kills === 0 && life.length >= 500) out.push("pacifist");
  if (life.noboostLength >= 300) out.push("purist");
  if (life.remains >= 500) out.push("scavenger");
  if (life.survive >= 900) out.push("marathon");
  return out;
}

export interface NextStep {
  a: Achievement;
  have: number;
  frac: number;
}

/**
 * The nearest unfinished milestone per group, best fraction first, so the
 * death card can say "3 more kills to Hunter II".
 */
export function nextSteps(t: Totals, unlocked: ReadonlySet<string>, n = 3): NextStep[] {
  const seen = new Set<string>();
  const out: NextStep[] = [];
  for (const a of ACHIEVEMENTS) {
    if (a.kind !== "total" || !a.stat || a.target === undefined) continue;
    if (unlocked.has(a.id) || seen.has(a.group)) continue;
    seen.add(a.group);
    const have = t[a.stat];
    out.push({ a, have, frac: Math.min(1, have / a.target) });
  }
  return out.sort((x, y) => y.frac - x.frac).slice(0, n);
}

/** Per group, the highest tier reached (or the first tier, locked). */
export function groupSummary(unlocked: ReadonlySet<string>): { a: Achievement; done: boolean }[] {
  const byGroup = new Map<string, Achievement[]>();
  for (const a of ACHIEVEMENTS) {
    const list = byGroup.get(a.group) ?? [];
    list.push(a);
    byGroup.set(a.group, list);
  }
  const out: { a: Achievement; done: boolean }[] = [];
  for (const list of byGroup.values()) {
    const best = [...list].reverse().find((a) => unlocked.has(a.id));
    out.push(best ? { a: best, done: true } : { a: list[0]!, done: false });
  }
  return out;
}
