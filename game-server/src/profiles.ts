/**
 * Persistent player profiles keyed by a device key the client generates.
 * Held in memory for the life of the instance and, when DATABASE_URL is
 * set, upserted to Postgres so they survive instance recycling and are
 * shared across instances.
 */
import pg from "pg";
import { retryDb } from "./db-retry";
import {
  CHEST_SHARDS,
  COSMETIC_ORDER,
  cosmeticName,
  FREEZE_EVERY_GAMES,
  LEAGUES,
  LEAGUE_REWARDS,
  STREAK_MILESTONES,
  WEEKLY_GOAL,
  bankedTierOf,
  dailyChallenges,
  isoWeek,
  lifeValue,
  nextStreak,
  seasonOf,
  todayUtc,
  type Challenge,
  type LifeStats,
} from "../../src/game/challenges";
import {
  LEAGUE_FEATS,
  seasonFeats,
  totalsUnlocked,
  type Totals,
} from "../../src/game/achievements";
import type { Identity } from "./identity";

export interface Profile {
  key: string;
  name: string;
  best: number;
  kills: number;
  games: number;
  /** Longest single life, in seconds. */
  survive: number;
  /** Cosmetic unlock bitmask (see challenges.ts). */
  unlocks: number;
  day: string;
  progress: number[];
  done: boolean[];
  /** Look of the last life, for the leaderboard page. */
  skin: number;
  bands: string[];
  /** Where the all-time best run ended. */
  bestX: number;
  bestY: number;
  /** This ISO week's best and challenge completions; weeks earned list. */
  week: string;
  weekBest: number;
  weekDone: number;
  earned: string[];
  /** Automated-play suspicion, kept off the leaderboard page. */
  flagged: boolean;
  /** Daily streak: consecutive UTC days with at least one life. */
  streak: number;
  streakLast: string;
  freezes: number;
  /** Lifetime totals for levels and titles. */
  eaten: number;
  nearTotal: number;
  bountyTotal: number;
  /** League tier finished last week (0 = none yet), and this season's best. */
  prevTier: number;
  season: number;
  seasonBest: number;
  /** Chest shards (three make a cosmetic), chests opened, crew tag, crown expiry. */
  shards: number;
  chests: number;
  crew: string;
  crownUntil: number;
  /** Linked account: stable id, public handle and avatar; "" for a device profile. */
  sub: string;
  handle: string;
  /** The player chose the handle; `link` keeps it instead of deriving one. */
  handleChosen: boolean;
  avatar: string;
  /** Achievement id to the unix second it was earned. */
  achv: Record<string, number>;
  /**
   * League stakes. `weekRuns[i]` counts this week's lives finishing at or
   * above tier i's length; `bankedTier` is the highest with enough of them;
   * `seasonTier` the best banked this season; `seasons` the finished
   * seasons as [season, tier]; `pending` reward notices not yet shown.
   */
  weekRuns: number[];
  weekLives: number;
  bankedTier: number;
  seasonTier: number;
  seasons: [number, number][];
  pending: string[];
  /** Achievements awarded by a roll, to toast on the next connection (not persisted). */
  pendingAchv: string[];
}

/** What the public profile page shows. */
export interface PublicProfile {
  handle: string;
  name: string;
  avatar: string;
  best: number;
  kills: number;
  games: number;
  survive: number;
  eaten: number;
  nearTotal: number;
  bountyTotal: number;
  streak: number;
  chests: number;
  weekBest: number;
  seasonBest: number;
  prevTier: number;
  bankedTier: number;
  weekRuns: number[];
  weekLives: number;
  seasonTier: number;
  seasons: [number, number][];
  rank: number;
  skin: number;
  bands: string[];
  crew: string;
  crowned: boolean;
  achv: Record<string, number>;
}

function parseRuns(v: unknown): number[] {
  const list = Array.isArray(v) ? v : [];
  return [0, 1, 2, 3, 4].map((i) => Math.max(0, Math.floor(Number(list[i]) || 0)));
}

function parseSeasons(v: unknown): [number, number][] {
  if (!Array.isArray(v)) return [];
  const out: [number, number][] = [];
  for (const e of v) {
    if (!Array.isArray(e) || e.length < 2) continue;
    const season = Number(e[0]);
    const tier = Number(e[1]);
    if (season > 0 && tier >= 1 && tier <= LEAGUES.length) out.push([season, tier]);
  }
  return out;
}

function parseStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
}

function parseAchv(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === "object" && !Array.isArray(v))
    for (const [k, t] of Object.entries(v as Record<string, unknown>))
      if (/^[a-z0-9_]{1,32}$/.test(k) && typeof t === "number") out[k] = t;
  return out;
}

export interface TopEntry {
  name: string;
  best: number;
  kills: number;
  games: number;
  skin: number;
  bands: string[];
  /** Linked account handle for a profile link, "" otherwise. */
  handle: string;
  avatar: string;
}

/** Split a pending roll line into the tier it is about and its text. */
export function rollLine(line: string): { tier: number; text: string } {
  const m = /^#(\d) (.*)$/s.exec(line);
  return m ? { tier: Number(m[1]), text: m[2]! } : { tier: 0, text: line };
}

export interface ChallengeView {
  challenge: Challenge;
  progress: number;
  done: boolean;
}

/** A cached profile nobody has asked for in this long may be forgotten (see `sweep`). */
export const PROFILE_IDLE_MS = 10 * 60_000;

export class ProfileStore {
  private readonly cache = new Map<string, Profile>();
  /** Loads in progress, so two sockets asking for one key share a single Profile object. */
  private readonly loading = new Map<string, Promise<Profile>>();
  private readonly dirty = new Set<string>();
  private readonly versions = new Map<string, number>();
  /** When each cached profile was last asked for, so idle ones can be forgotten. */
  private readonly lastUsed = new Map<string, number>();
  private pool: pg.Pool | null = null;

  /** The shared connection pool, for the arena coordinator. */
  get db(): pg.Pool | null {
    return this.pool;
  }
  private ready: Promise<void> | null = null;
  private initialized = false;
  private flushing = false;

  /** Without an argument the pool comes from DATABASE_URL; tests pass a stub (or null). */
  constructor(pool?: pg.Pool | null) {
    const url = process.env.DATABASE_URL?.trim();
    if (pool !== undefined) this.pool = pool;
    else if (url) {
      this.pool = new pg.Pool({
        connectionString: url,
        max: 2,
        ssl: /sslmode=(require|verify)/.test(url) ? { rejectUnauthorized: true } : undefined,
      });
    }
    if (this.pool) {
      void this.ensureReady().catch((err) => {
        console.error("[profiles] init failed:", (err as Error)?.message ?? err);
      });
      setInterval(() => void this.flush(), 5000).unref();
    }
  }

  private ensureReady(): Promise<void> {
    if (!this.pool || this.initialized) return Promise.resolve();
    if (!this.ready) {
      this.ready = retryDb(async () => {
        await this.pool!.query(
          `CREATE TABLE IF NOT EXISTS agencoil_profiles (
             key TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
             best INTEGER NOT NULL DEFAULT 0, kills INTEGER NOT NULL DEFAULT 0,
             games INTEGER NOT NULL DEFAULT 0, survive INTEGER NOT NULL DEFAULT 0,
             unlocks INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL DEFAULT '',
             progress JSONB NOT NULL DEFAULT '[]', updated TIMESTAMPTZ NOT NULL DEFAULT now())`,
        );
        await this.pool!.query(
          `ALTER TABLE agencoil_profiles
             ADD COLUMN IF NOT EXISTS skin INTEGER NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS bands JSONB NOT NULL DEFAULT '[]',
             ADD COLUMN IF NOT EXISTS best_x REAL NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS best_y REAL NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS week TEXT NOT NULL DEFAULT '',
             ADD COLUMN IF NOT EXISTS week_best INTEGER NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS week_done INTEGER NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS earned JSONB NOT NULL DEFAULT '[]',
             ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT false,
             ADD COLUMN IF NOT EXISTS streak INTEGER NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS streak_last TEXT NOT NULL DEFAULT '',
             ADD COLUMN IF NOT EXISTS freezes INTEGER NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS eaten INTEGER NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS near_total INTEGER NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS bounty_total INTEGER NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS prev_tier INTEGER NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS season INTEGER NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS season_best INTEGER NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS shards INTEGER NOT NULL DEFAULT 1,
             ADD COLUMN IF NOT EXISTS chests INTEGER NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS crew TEXT NOT NULL DEFAULT '',
             ADD COLUMN IF NOT EXISTS crown_until BIGINT NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS sub TEXT NOT NULL DEFAULT '',
             ADD COLUMN IF NOT EXISTS handle TEXT NOT NULL DEFAULT '',
             ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT '',
             ADD COLUMN IF NOT EXISTS achv JSONB NOT NULL DEFAULT '{}',
             ADD COLUMN IF NOT EXISTS week_runs JSONB NOT NULL DEFAULT '[]',
             ADD COLUMN IF NOT EXISTS week_lives INTEGER NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS banked_tier INTEGER NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS season_tier INTEGER NOT NULL DEFAULT 0,
             ADD COLUMN IF NOT EXISTS seasons JSONB NOT NULL DEFAULT '[]',
             ADD COLUMN IF NOT EXISTS pending JSONB NOT NULL DEFAULT '[]',
             ADD COLUMN IF NOT EXISTS handle_chosen BOOLEAN NOT NULL DEFAULT false`,
        );
        await this.pool!.query(
          `CREATE INDEX IF NOT EXISTS agencoil_profiles_handle ON agencoil_profiles (handle) WHERE handle <> ''`,
        );
        // Rank is a count of better bests after every death, and the boards
        // sort by these; without indexes each is a full table scan.
        await this.pool!.query(
          `CREATE INDEX IF NOT EXISTS agencoil_profiles_best ON agencoil_profiles (best DESC)`,
        );
        await this.pool!.query(
          `CREATE INDEX IF NOT EXISTS agencoil_profiles_week ON agencoil_profiles (week, week_best DESC)`,
        );
        await this.pool!.query(
          `CREATE INDEX IF NOT EXISTS agencoil_profiles_season ON agencoil_profiles (season, season_best DESC)`,
        );
      })
        .then(() => {
          this.initialized = true;
        })
        .catch((error) => {
          this.ready = null;
          throw error;
        });
    }
    return this.ready;
  }

  get persistent(): boolean {
    return this.pool !== null && this.initialized;
  }

  private markDirty(key: string): void {
    this.dirty.add(key);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }

  private fresh(key: string, name: string): Profile {
    return {
      key,
      name,
      best: 0,
      kills: 0,
      games: 0,
      survive: 0,
      unlocks: 0,
      day: todayUtc(),
      progress: [0, 0, 0],
      done: [false, false, false],
      skin: 0,
      bands: [],
      bestX: 0,
      bestY: 0,
      week: isoWeek(),
      weekBest: 0,
      weekDone: 0,
      earned: [],
      flagged: false,
      streak: 0,
      streakLast: "",
      freezes: 0,
      eaten: 0,
      nearTotal: 0,
      bountyTotal: 0,
      prevTier: 0,
      season: seasonOf(),
      seasonBest: 0,
      // Endowed progress: a new profile already holds one shard of three.
      shards: 1,
      chests: 0,
      crew: "",
      crownUntil: 0,
      sub: "",
      handle: "",
      handleChosen: false,
      avatar: "",
      achv: {},
      weekRuns: [0, 0, 0, 0, 0],
      weekLives: 0,
      bankedTier: 0,
      seasonTier: 0,
      seasons: [],
      pending: [],
      pendingAchv: [],
    };
  }

  async load(key: string, name: string): Promise<Profile> {
    const cached = this.cache.get(key);
    if (cached) {
      this.lastUsed.set(key, Date.now());
      this.setName(cached, name);
      this.rollDay(cached);
      return cached;
    }
    const inFlight = this.loading.get(key);
    if (inFlight) {
      const p = await inFlight;
      this.setName(p, name);
      return p;
    }
    const task = this.fetch(key, name).finally(() => this.loading.delete(key));
    this.loading.set(key, task);
    return task;
  }

  /** Read one profile from the database (or start a fresh one) and cache it. */
  private async fetch(key: string, name: string): Promise<Profile> {
    let p = this.fresh(key, name);
    if (this.pool) {
      try {
        await this.ensureReady();
        const rows = await retryDb(() =>
          this.pool!.query<{
            name: string;
            best: number;
            kills: number;
            games: number;
            survive: number;
            unlocks: number;
            day: string;
            progress: unknown;
            skin: number;
            bands: unknown;
            best_x: number;
            best_y: number;
            week: string;
            week_best: number;
            week_done: number;
            earned: unknown;
            flagged: boolean;
            streak: number;
            streak_last: string;
            freezes: number;
            eaten: number;
            near_total: number;
            bounty_total: number;
            prev_tier: number;
            season: number;
            season_best: number;
            shards: number;
            chests: number;
            crew: string;
            crown_until: string | number;
            sub: string;
            handle: string;
            avatar: string;
            achv: unknown;
            week_runs: unknown;
            week_lives: number;
            banked_tier: number;
            season_tier: number;
            seasons: unknown;
            pending: unknown;
            handle_chosen: boolean;
          }>(
            `SELECT name, best, kills, games, survive, unlocks, day, progress, skin, bands, best_x, best_y,
                  week, week_best, week_done, earned, flagged, streak, streak_last, freezes, eaten,
                  near_total, bounty_total, prev_tier, season, season_best, shards, chests, crew,
                  crown_until, sub, handle, avatar, achv, week_runs, week_lives, banked_tier,
                  season_tier, seasons, pending, handle_chosen
           FROM agencoil_profiles WHERE key = $1`,
            [key],
          ),
        );
        const r = rows.rows[0];
        if (r) {
          const prog = Array.isArray(r.progress) ? (r.progress as unknown[]) : [];
          p = {
            key,
            name,
            best: Number(r.best),
            kills: Number(r.kills),
            games: Number(r.games),
            survive: Number(r.survive),
            unlocks: Number(r.unlocks),
            day: r.day,
            progress: [0, 1, 2].map((i) => Number(prog[i] ?? 0)),
            done: [0, 1, 2].map((i) => Number(prog[i + 3] ?? 0) === 1),
            skin: Number(r.skin) || 0,
            bands: Array.isArray(r.bands)
              ? (r.bands as string[]).filter((b) => typeof b === "string")
              : [],
            bestX: Number(r.best_x) || 0,
            bestY: Number(r.best_y) || 0,
            week: r.week || isoWeek(),
            weekBest: Number(r.week_best) || 0,
            weekDone: Number(r.week_done) || 0,
            earned: Array.isArray(r.earned)
              ? (r.earned as string[]).filter((w) => typeof w === "string")
              : [],
            flagged: Boolean(r.flagged),
            streak: Number(r.streak) || 0,
            streakLast: r.streak_last || "",
            freezes: Number(r.freezes) || 0,
            eaten: Number(r.eaten) || 0,
            nearTotal: Number(r.near_total) || 0,
            bountyTotal: Number(r.bounty_total) || 0,
            prevTier: Number(r.prev_tier) || 0,
            season: Number(r.season) || seasonOf(),
            seasonBest: Number(r.season_best) || 0,
            shards: Number(r.shards) || 0,
            chests: Number(r.chests) || 0,
            crew: r.crew || "",
            crownUntil: Number(r.crown_until) || 0,
            sub: r.sub || "",
            handle: r.handle || "",
            handleChosen: Boolean(r.handle_chosen),
            avatar: r.avatar || "",
            achv: parseAchv(r.achv),
            weekRuns: parseRuns(r.week_runs),
            weekLives: Number(r.week_lives) || 0,
            bankedTier: Number(r.banked_tier) || 0,
            seasonTier: Number(r.season_tier) || 0,
            seasons: parseSeasons(r.seasons),
            pending: parseStrings(r.pending),
            pendingAchv: [],
          };
        }
      } catch (err) {
        console.error("[profiles] load failed:", (err as Error)?.message ?? err);
        throw err;
      }
    }
    this.rollDay(p);
    this.cache.set(key, p);
    this.lastUsed.set(key, Date.now());
    return p;
  }

  /**
   * Forget cached profiles nobody has used for a while, so an arena that
   * runs for weeks does not keep every visitor it ever saw. `inUse` names
   * the keys connected clients still hold; those stay, as do rows waiting
   * for a flush, loads in flight and toasts not yet shown. Without a
   * database the cache is the store, so nothing is ever dropped. Returns
   * how many were forgotten.
   */
  sweep(inUse: ReadonlySet<string>, idleMs = PROFILE_IDLE_MS, now = Date.now()): number {
    if (!this.pool) return 0;
    for (const key of inUse) if (this.cache.has(key)) this.lastUsed.set(key, now);
    let dropped = 0;
    for (const [key, p] of this.cache) {
      if (inUse.has(key) || this.dirty.has(key) || this.loading.has(key)) continue;
      if (p.pendingAchv.length) continue;
      if (now - (this.lastUsed.get(key) ?? 0) < idleMs) continue;
      this.cache.delete(key);
      this.versions.delete(key);
      this.lastUsed.delete(key);
      dropped++;
    }
    return dropped;
  }

  private rollDay(p: Profile): void {
    const today = todayUtc();
    const week = isoWeek();
    if (p.week !== week) {
      // The week ends: what was banked is the finish, and it pays now. One
      // lucky run banks nothing; three lives at a tier's length do.
      const finish = p.bankedTier;
      p.prevTier = finish;
      if (finish > 0) {
        const name = LEAGUES[finish - 1]!.name;
        const reward = LEAGUE_REWARDS[finish - 1]!;
        const got: string[] = [];
        for (let i = 0; i < reward.chests; i++) got.push(this.openChest(p));
        if (reward.shards) got.push(this.addShards(p, reward.shards));
        if (reward.aura) got.push(`the ${name.toLowerCase()} aura around your head this week`);
        // A "#tier " prefix tells the client which crest to draw on the card.
        p.pending.push(`#${finish} last week you banked ${name}: ${got.join("; ")}`);
      } else if (p.weekLives > 0) {
        p.pending.push(
          "#0 last week banked no tier: three lives at a tier's length bank it for rewards",
        );
      }
      p.seasonTier = Math.max(p.seasonTier, finish);
      p.week = week;
      p.weekBest = 0;
      p.weekDone = 0;
      p.weekRuns = [0, 0, 0, 0, 0];
      p.weekLives = 0;
      p.bankedTier = 0;
      this.markDirty(p.key);
    }
    const season = seasonOf();
    if (p.season !== season) {
      // The season ends: the best banked tier goes on the profile for good.
      if (p.seasonTier > 0) {
        p.seasons.push([p.season, p.seasonTier]);
        if (p.seasons.length > 50) p.seasons.splice(0, p.seasons.length - 50);
        const name = LEAGUES[p.seasonTier - 1]!.name;
        p.pending.push(
          `#${p.seasonTier} season ${p.season} finished in ${name}: it stays on your profile`,
        );
        for (const id of seasonFeats(p.seasonTier)) if (this.award(p, id)) p.pendingAchv.push(id);
      }
      p.season = season;
      p.seasonBest = 0;
      p.seasonTier = 0;
      this.markDirty(p.key);
    }
    if (p.day === today) return;
    p.day = today;
    p.progress = [0, 0, 0];
    p.done = [false, false, false];
    this.markDirty(p.key);
  }

  setName(p: Profile, name: string): void {
    if (!name || name === "anon" || p.name === name) return;
    p.name = name;
    this.markDirty(p.key);
  }

  /** Remember the look used for a life. */
  setLook(p: Profile, skin: number, bands: string[] | undefined): void {
    p.skin = skin;
    p.bands = bands ?? [];
    this.markDirty(p.key);
  }

  flag(p: Profile): void {
    if (p.flagged) return;
    p.flagged = true;
    this.markDirty(p.key);
  }

  challenges(p: Profile): ChallengeView[] {
    this.rollDay(p);
    return dailyChallenges(p.day).map((c, i) => ({
      challenge: c,
      progress: p.progress[i] ?? 0,
      done: p.done[i] ?? false,
    }));
  }

  /**
   * Daily streak on the first life of a UTC day. A single missed day is
   * bridged by a banked freeze; otherwise the streak restarts at one. Returns
   * milestone labels reached today.
   */
  private touchStreak(p: Profile): string[] {
    const today = p.day;
    const next = nextStreak(p.streak, p.streakLast, p.freezes, today);
    if (next.playedToday) return [];
    const reached: string[] = [];
    if (next.usesFreeze) p.freezes--;
    p.streak = next.streak;
    p.streakLast = today;
    for (const m of STREAK_MILESTONES) {
      if (p.streak >= m.days && !(p.unlocks & m.unlock)) {
        p.unlocks |= m.unlock;
        reached.push(m.label);
      }
    }
    return reached;
  }

  /** Fold a finished life into the profile; returns challenges completed by it. */
  recordLife(
    p: Profile,
    life: LifeStats,
    at?: { x: number; y: number },
  ): {
    completed: Challenge[];
    milestones: string[];
    freezeEarned: boolean;
    chest: boolean;
    /** A tier newly banked by this life (1 Bronze to 5 Diamond), else 0. */
    banked: number;
  } {
    this.rollDay(p);
    const milestones = this.touchStreak(p);
    p.games++;
    p.kills += life.kills;
    p.eaten += Math.max(0, life.length - 10);
    p.nearTotal += life.near;
    p.bountyTotal += life.bounty;
    if (life.length > p.seasonBest) p.seasonBest = life.length;
    let freezeEarned = false;
    if (p.games % FREEZE_EVERY_GAMES === 0 && p.freezes < 1) {
      p.freezes = 1;
      freezeEarned = true;
    }
    if (life.length > p.best) {
      p.best = life.length;
      if (at) {
        p.bestX = Math.round(at.x);
        p.bestY = Math.round(at.y);
      }
    }
    if (life.length > p.weekBest) p.weekBest = life.length;
    if (life.survive > p.survive) p.survive = Math.floor(life.survive);
    // League stakes: this life counts for every tier its length reaches.
    p.weekLives++;
    for (let i = 0; i < LEAGUES.length; i++) {
      if (life.length >= LEAGUES[i]!.min) p.weekRuns[i] = (p.weekRuns[i] ?? 0) + 1;
    }
    const bankedBefore = p.bankedTier;
    p.bankedTier = Math.max(p.bankedTier, bankedTierOf(p.weekRuns));
    const banked = p.bankedTier > bankedBefore ? p.bankedTier : 0;
    if (banked) p.seasonTier = Math.max(p.seasonTier, banked);
    const completed: Challenge[] = [];
    // Quests are a chain: only the first unfinished step takes this life's
    // numbers, so each step is a goal you play toward on purpose.
    const chain = dailyChallenges(p.day);
    const active = chain.findIndex((_, i) => !p.done[i]);
    let chest = false;
    if (active >= 0) {
      const c = chain[active]!;
      const v = Math.min(c.target, Math.floor(lifeValue(c, life)));
      if (v > (p.progress[active] ?? 0)) p.progress[active] = v;
      if (v >= c.target) {
        p.done[active] = true;
        p.unlocks |= c.unlock;
        p.weekDone++;
        completed.push(c);
        if (active === chain.length - 1) chest = true;
      }
    }
    if (p.weekDone >= WEEKLY_GOAL && !p.earned.includes(p.week)) p.earned.push(p.week);
    this.markDirty(p.key);
    return { completed, milestones, freezeEarned, chest, banked };
  }

  /** The feat a newly banked tier earns, if it is new to this profile. */
  bankFeat(p: Profile, tier: number): string | null {
    const id = LEAGUE_FEATS[tier - 1];
    return id && this.award(p, id) ? id : null;
  }

  /**
   * Reward notices and toasts queued by a week or season roll; cleared once
   * taken. Lines start with "#tier " (0 for none), see `rollLine`.
   */
  drainPending(p: Profile): { lines: string[]; achv: string[] } {
    const lines = p.pending;
    const achv = p.pendingAchv;
    if (!lines.length && !achv.length) return { lines: [], achv: [] };
    p.pending = [];
    p.pendingAchv = [];
    if (lines.length) this.markDirty(p.key);
    return { lines, achv };
  }

  /** Add shards, unlocking a cosmetic for every full set. Returns what to tell the player. */
  private addShards(p: Profile, n: number): string {
    p.shards += n;
    const unlocked: string[] = [];
    while (p.shards >= CHEST_SHARDS) {
      p.shards -= CHEST_SHARDS;
      const next = COSMETIC_ORDER.find((bit) => !(p.unlocks & bit));
      if (next === undefined) break;
      p.unlocks |= next;
      unlocked.push(cosmeticName(next));
    }
    this.markDirty(p.key);
    const shards = `${n} shard${n === 1 ? "" : "s"} (${p.shards}/${CHEST_SHARDS})`;
    return unlocked.length ? `${shards}, ${unlocked.join(" and ")} unlocked` : shards;
  }

  /**
   * Open a chest: one shard; every third shard unlocks the next cosmetic
   * the profile does not own. Returns what to tell the player.
   */
  openChest(p: Profile): string {
    p.chests++;
    p.shards++;
    this.markDirty(p.key);
    if (p.shards < CHEST_SHARDS) return `chest opened: shard ${p.shards}/${CHEST_SHARDS}`;
    p.shards -= CHEST_SHARDS;
    const next = COSMETIC_ORDER.find((bit) => !(p.unlocks & bit));
    if (next === undefined) return "chest opened: every cosmetic is already yours";
    p.unlocks |= next;
    return `chest opened: ${cosmeticName(next)} unlocked`;
  }

  setCrew(p: Profile, tag: string): void {
    p.crew = tag;
    this.markDirty(p.key);
  }

  setCrown(p: Profile, until: number): void {
    p.crownUntil = until;
    this.markDirty(p.key);
  }

  /** Crew board: members' week bests summed, this ISO week, flagged accounts excluded. */
  async topCrews(n: number): Promise<TopEntry[]> {
    const week = isoWeek();
    if (this.pool) {
      try {
        await this.ensureReady();
        const res = await this.pool.query<{ crew: string; best: number; members: number }>(
          `SELECT crew, sum(week_best)::int AS best, count(*)::int AS members
           FROM agencoil_profiles
           WHERE crew <> '' AND week = $2 AND flagged = false
           GROUP BY crew ORDER BY best DESC LIMIT $1`,
          [n, week],
        );
        return res.rows.map((r) => ({
          name: r.crew,
          best: Number(r.best) || 0,
          kills: 0,
          games: Number(r.members) || 0,
          skin: 0,
          bands: [],
          handle: "",
          avatar: "",
        }));
      } catch (err) {
        console.error("[profiles] topCrews failed:", (err as Error)?.message ?? err);
      }
    }
    const sums = new Map<string, { best: number; members: number }>();
    for (const p of this.cache.values()) {
      if (!p.crew || p.flagged || p.week !== week) continue;
      const e = sums.get(p.crew) ?? { best: 0, members: 0 };
      e.best += p.weekBest;
      e.members++;
      sums.set(p.crew, e);
    }
    return [...sums.entries()]
      .map(([name, e]) => ({
        name,
        best: e.best,
        kills: 0,
        games: e.members,
        skin: 0,
        bands: [],
        handle: "",
        avatar: "",
      }))
      .sort((a, b) => b.best - a.best)
      .slice(0, n);
  }

  async top(kind: "alltime" | "weekly" | "season", n: number): Promise<TopEntry[]> {
    const week = isoWeek();
    const season = seasonOf();
    if (this.pool) {
      try {
        await this.ensureReady();
        const col = kind === "weekly" ? "week_best" : kind === "season" ? "season_best" : "best";
        const where =
          kind === "weekly"
            ? `AND week = $2 AND week_best > 0`
            : kind === "season"
              ? `AND season = $2 AND season_best > 0`
              : `AND best > 0`;
        const params: unknown[] = [n];
        if (kind === "weekly") params.push(week);
        if (kind === "season") params.push(season);
        const rows = await retryDb(() =>
          this.pool!.query<{
            name: string;
            score: number;
            kills: number;
            games: number;
            skin: number;
            bands: unknown;
            handle: string;
            avatar: string;
          }>(
            `SELECT name, ${col} AS score, kills, games, skin, bands, handle, avatar FROM agencoil_profiles
           WHERE flagged = false ${where} ORDER BY ${col} DESC, updated DESC LIMIT $1`,
            params,
          ),
        );
        return rows.rows.map((r) => ({
          name: r.name,
          best: Number(r.score),
          kills: Number(r.kills),
          games: Number(r.games),
          skin: Number(r.skin) || 0,
          bands: Array.isArray(r.bands) ? (r.bands as string[]) : [],
          handle: r.handle || "",
          avatar: r.avatar || "",
        }));
      } catch (err) {
        console.error("[profiles] top failed:", (err as Error)?.message ?? err);
      }
    }
    return [...this.cache.values()]
      .filter((p) => !p.flagged)
      .map((p) => ({
        name: p.name,
        best:
          kind === "weekly"
            ? p.week === week
              ? p.weekBest
              : 0
            : kind === "season"
              ? p.season === season
                ? p.seasonBest
                : 0
              : p.best,
        kills: p.kills,
        games: p.games,
        skin: p.skin,
        bands: p.bands,
        handle: p.handle,
        avatar: p.avatar,
      }))
      .filter((e) => e.best > 0)
      .sort((a, b) => b.best - a.best)
      .slice(0, n);
  }

  /** Lifetime totals the achievement milestones are measured against. */
  totals(p: Profile): Totals {
    return {
      best: p.best,
      kills: p.kills,
      games: p.games,
      survive: p.survive,
      eaten: p.eaten,
      nearTotal: p.nearTotal,
      bountyTotal: p.bountyTotal,
      streak: p.streak,
      chests: p.chests,
    };
  }

  /** Give an achievement once. True when it is new. */
  award(p: Profile, id: string): boolean {
    if (p.achv[id]) return false;
    p.achv[id] = Math.floor(Date.now() / 1000);
    this.markDirty(p.key);
    return true;
  }

  /** Award every lifetime milestone the totals now satisfy; returns the new ones. */
  awardTotals(p: Profile): string[] {
    const out: string[] = [];
    for (const id of totalsUnlocked(this.totals(p))) if (this.award(p, id)) out.push(id);
    return out;
  }

  /**
   * Attach an account to a player. The account's profile lives under
   * `acct:<sub>`; the first sign-in adopts the device profile the player has
   * been building (renamed in place, so nothing is lost), later sign-ins
   * from any device land on the account profile.
   */
  async link(device: Profile | null, id: Identity, name: string): Promise<Profile> {
    const key = `acct:${id.sub}`;
    let p = this.cache.get(key) ?? null;
    if (!p && this.pool) {
      try {
        await this.ensureReady();
        const r = await retryDb(() =>
          this.pool!.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM agencoil_profiles WHERE key = $1`,
            [key],
          ),
        );
        if (Number(r.rows[0]?.n ?? 0) > 0) p = await this.load(key, name);
      } catch (err) {
        console.error("[profiles] link lookup failed:", (err as Error)?.message ?? err);
      }
    }
    if (!p && device && !device.sub && (device.games > 0 || device.best > 0)) {
      // Adopt the device profile: rename it so its history becomes the account's.
      if (this.pool) {
        try {
          await this.ensureReady();
          await retryDb(() =>
            this.pool!.query(
              `UPDATE agencoil_profiles SET key = $1 WHERE key = $2
                 AND NOT EXISTS (SELECT 1 FROM agencoil_profiles WHERE key = $1)`,
              [key, device.key],
            ),
          );
        } catch (err) {
          console.error("[profiles] adopt failed:", (err as Error)?.message ?? err);
        }
      }
      this.cache.delete(device.key);
      this.dirty.delete(device.key);
      this.versions.delete(device.key);
      this.lastUsed.delete(device.key);
      device.key = key;
      p = device;
      this.cache.set(key, p);
      this.lastUsed.set(key, Date.now());
    }
    if (!p) p = await this.load(key, name);
    p.sub = id.sub;
    p.avatar = id.avatar;
    // A handle the player chose stays; a derived one follows the account.
    p.handle = p.handleChosen && p.handle ? p.handle : await this.freeHandle(id.handle, key);
    // The profile keeps the account's display name; the arena name is the handle.
    this.setName(p, id.name || name);
    this.markDirty(key);
    return p;
  }

  /** Does another profile hold this handle? Throws when the database cannot be asked. */
  private async handleTaken(h: string, key: string): Promise<boolean> {
    for (const o of this.cache.values()) if (o.handle === h && o.key !== key) return true;
    if (!this.pool) return false;
    const r = await retryDb(() =>
      this.pool!.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM agencoil_profiles WHERE handle = $1 AND key <> $2`,
        [h, key],
      ),
    );
    return Number(r.rows[0]?.n ?? 0) > 0;
  }

  /** The handle itself, or a suffixed one when another account already holds it. */
  private async freeHandle(handle: string, key: string): Promise<string> {
    try {
      if (!(await this.handleTaken(handle, key))) return handle;
      for (let i = 2; i < 100; i++) {
        const h = `${handle.slice(0, 12)}_${i}`;
        if (!(await this.handleTaken(h, key))) return h;
      }
    } catch (err) {
      console.error("[profiles] handle check failed:", (err as Error)?.message ?? err);
    }
    return `${handle.slice(0, 8)}_${key.slice(-6)}`;
  }

  /**
   * Give a profile the handle its player chose. "taken" when another
   * profile holds it. A chosen handle is kept across sign-ins instead of
   * being derived again. Throws when the database cannot be asked.
   */
  async claimHandle(p: Profile, handle: string): Promise<"ok" | "taken"> {
    if (p.handle !== handle && (await this.handleTaken(handle, p.key))) return "taken";
    p.handle = handle;
    p.handleChosen = true;
    this.markDirty(p.key);
    return "ok";
  }

  /** The profile behind a public handle, or null. */
  async byHandle(handle: string): Promise<Profile | null> {
    if (!handle) return null;
    for (const p of this.cache.values()) if (p.handle === handle) return p;
    if (!this.pool) return null;
    try {
      await this.ensureReady();
      const r = await retryDb(() =>
        this.pool!.query<{ key: string; name: string }>(
          `SELECT key, name FROM agencoil_profiles WHERE handle = $1 LIMIT 1`,
          [handle],
        ),
      );
      const row = r.rows[0];
      if (!row) return null;
      return await this.load(row.key, row.name);
    } catch (err) {
      console.error("[profiles] byHandle failed:", (err as Error)?.message ?? err);
      return null;
    }
  }

  publicProfile(p: Profile, rank: number): PublicProfile {
    return {
      handle: p.handle,
      name: p.name,
      avatar: p.avatar,
      best: p.best,
      kills: p.kills,
      games: p.games,
      survive: p.survive,
      eaten: p.eaten,
      nearTotal: p.nearTotal,
      bountyTotal: p.bountyTotal,
      streak: p.streak,
      chests: p.chests,
      weekBest: p.week === isoWeek() ? p.weekBest : 0,
      seasonBest: p.season === seasonOf() ? p.seasonBest : 0,
      prevTier: p.prevTier,
      bankedTier: p.bankedTier,
      weekRuns: p.weekRuns,
      weekLives: p.weekLives,
      seasonTier: p.seasonTier,
      seasons: p.seasons,
      rank,
      skin: p.skin,
      bands: p.bands,
      crew: p.crew,
      crowned: p.crownUntil > Date.now(),
      achv: p.achv,
    };
  }

  private rarityCache: {
    at: number;
    value: { players: number; counts: Record<string, number> };
  } | null = null;

  /** How many players hold each achievement, for "2% of players have this". */
  async rarity(): Promise<{ players: number; counts: Record<string, number> }> {
    if (this.rarityCache && Date.now() - this.rarityCache.at < 300_000)
      return this.rarityCache.value;
    let value = { players: 0, counts: {} as Record<string, number> };
    if (this.pool) {
      try {
        await this.ensureReady();
        const [tot, per] = await Promise.all([
          retryDb(() =>
            this.pool!.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM agencoil_profiles WHERE games > 0`,
            ),
          ),
          retryDb(() =>
            this.pool!.query<{ k: string; n: string }>(
              `SELECT k, count(*)::text AS n FROM agencoil_profiles, jsonb_object_keys(achv) AS k GROUP BY k`,
            ),
          ),
        ]);
        value = { players: Number(tot.rows[0]?.n ?? 0), counts: {} };
        for (const r of per.rows) value.counts[r.k] = Number(r.n);
      } catch (err) {
        console.error("[profiles] rarity failed:", (err as Error)?.message ?? err);
      }
    } else {
      for (const p of this.cache.values()) {
        if (p.games > 0) value.players++;
        for (const k of Object.keys(p.achv)) value.counts[k] = (value.counts[k] ?? 0) + 1;
      }
    }
    this.rarityCache = { at: Date.now(), value };
    return value;
  }

  /** All-time rank by best length (1 = longest ever). */
  async rank(p: Profile): Promise<number> {
    if (p.best <= 0) return 0;
    if (this.pool) {
      try {
        await this.ensureReady();
        const r = await retryDb(() =>
          this.pool!.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM agencoil_profiles WHERE best > $1`,
            [p.best],
          ),
        );
        return Number(r.rows[0]?.n ?? 0) + 1;
      } catch {
        /* fall through to the in-memory estimate */
      }
    }
    let above = 0;
    for (const o of this.cache.values()) if (o.best > p.best) above++;
    return above + 1;
  }

  private async flush(): Promise<void> {
    if (!this.pool || this.flushing || !this.dirty.size) return;
    this.flushing = true;
    try {
      await this.ensureReady();
      if (!this.pool) return;
      // Upserts go out together; the pool serialises them over its
      // connections, instead of one round trip waiting on the last.
      const jobs = [...this.dirty].map(async (key) => {
        const p = this.cache.get(key);
        if (!p) {
          this.dirty.delete(key);
          return;
        }
        const version = this.versions.get(key) ?? 0;
        await retryDb(() =>
          this.pool!.query(
            `INSERT INTO agencoil_profiles (key, name, best, kills, games, survive, unlocks, day, progress,
             skin, bands, best_x, best_y, week, week_best, week_done, earned, flagged,
             streak, streak_last, freezes, eaten, near_total, bounty_total, prev_tier, season, season_best,
             shards, chests, crew, crown_until, sub, handle, avatar, achv,
             week_runs, week_lives, banked_tier, season_tier, seasons, pending, handle_chosen, updated)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
             $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35,
             $36, $37, $38, $39, $40, $41, $42, now())
           ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, best = GREATEST(agencoil_profiles.best, EXCLUDED.best),
             kills = GREATEST(agencoil_profiles.kills, EXCLUDED.kills),
             games = GREATEST(agencoil_profiles.games, EXCLUDED.games),
             survive = GREATEST(agencoil_profiles.survive, EXCLUDED.survive),
             unlocks = agencoil_profiles.unlocks | EXCLUDED.unlocks, day = EXCLUDED.day, progress = EXCLUDED.progress,
             skin = EXCLUDED.skin, bands = EXCLUDED.bands, best_x = EXCLUDED.best_x, best_y = EXCLUDED.best_y,
             week = EXCLUDED.week, week_best = EXCLUDED.week_best, week_done = EXCLUDED.week_done,
             earned = EXCLUDED.earned, flagged = agencoil_profiles.flagged OR EXCLUDED.flagged,
             streak = EXCLUDED.streak, streak_last = EXCLUDED.streak_last, freezes = EXCLUDED.freezes,
             eaten = EXCLUDED.eaten, near_total = EXCLUDED.near_total, bounty_total = EXCLUDED.bounty_total,
             prev_tier = EXCLUDED.prev_tier, season = EXCLUDED.season, season_best = EXCLUDED.season_best,
             shards = EXCLUDED.shards, chests = EXCLUDED.chests, crew = EXCLUDED.crew,
             crown_until = EXCLUDED.crown_until, sub = EXCLUDED.sub, handle = EXCLUDED.handle,
             avatar = EXCLUDED.avatar, achv = agencoil_profiles.achv || EXCLUDED.achv,
             week_runs = EXCLUDED.week_runs, week_lives = EXCLUDED.week_lives,
             banked_tier = EXCLUDED.banked_tier, season_tier = EXCLUDED.season_tier,
             seasons = EXCLUDED.seasons, pending = EXCLUDED.pending,
             handle_chosen = EXCLUDED.handle_chosen, updated = now()`,
            [
              p.key,
              p.name,
              p.best,
              p.kills,
              p.games,
              p.survive,
              p.unlocks,
              p.day,
              JSON.stringify([...p.progress, ...p.done.map((d) => (d ? 1 : 0))]),
              p.skin,
              JSON.stringify(p.bands),
              p.bestX,
              p.bestY,
              p.week,
              p.weekBest,
              p.weekDone,
              JSON.stringify(p.earned),
              p.flagged,
              p.streak,
              p.streakLast,
              p.freezes,
              p.eaten,
              p.nearTotal,
              p.bountyTotal,
              p.prevTier,
              p.season,
              p.seasonBest,
              p.shards,
              p.chests,
              p.crew,
              p.crownUntil,
              p.sub,
              p.handle,
              p.avatar,
              JSON.stringify(p.achv),
              JSON.stringify(p.weekRuns),
              p.weekLives,
              p.bankedTier,
              p.seasonTier,
              JSON.stringify(p.seasons),
              JSON.stringify(p.pending),
              p.handleChosen,
            ],
          ),
        );
        if ((this.versions.get(key) ?? 0) === version) this.dirty.delete(key);
      });
      for (const r of await Promise.allSettled(jobs)) {
        if (r.status === "rejected")
          console.error("[profiles] flush failed:", (r.reason as Error)?.message ?? r.reason);
      }
    } catch (err) {
      console.error("[profiles] flush failed:", (err as Error)?.message ?? err);
    } finally {
      this.flushing = false;
    }
  }
}
