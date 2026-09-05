/**
 * Authoritative arena server. One World per process; every connected player
 * is a snake steered by the inputs it sends, bots are run here, and clients
 * only receive what is near their camera.
 *
 * Runs unchanged as a Vercel Function (see ../api/ws.ts) or a plain Node
 * process (see ../dev.ts). Nothing here depends on the host.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import {
  ARENA_RADIUS,
  BOSS_DURATION_S,
  BOSS_MINUTE,
  BOSS_NAME,
  BOUNTY_MIN_MASS,
  HUNGER_RATE,
  LANDMARKS,
  WISP_BANK_MAX,
  WISP_REACH,
  WISP_SECS,
  BOUNTY_RATE,
  COMEBACK_KEEP,
  COMEBACK_WINDOW_MS,
  DISCONNECT_GRACE_MS,
  NEAR_COMBO_WINDOW,
  SWARM_DURATION_S,
  SWARM_EVERY_S,
  packSkin,
  unpackSkin,
  FOOD_SYNC_HZ,
  SERVER_BOTS,
  SERVER_BOTS_MIN,
  MAX_PLAYERS_PER_INSTANCE,
  MAX_CUSTOM_BANDS,
  MAX_NET_POINTS,
  SERVER_TICK_HZ,
  SNAPSHOT_HZ,
  START_MASS,
  dist2,
  lengthOf,
  radiusOf,
  zoomOf,
  type Snake,
} from "../../src/game/model";
import {
  CELL,
  World,
  type DeathEvent,
  cellCoordsOf,
  cellKey,
  cellKeyOf,
  hotCellCentre,
  hotKey,
} from "../../src/game/world";
import { moveWisp, slideAlongRim } from "../../src/game/wisp";
import { cleanName } from "./names";
import {
  C2S,
  HANDLE_INVALID,
  HANDLE_NOT_LINKED,
  HANDLE_OK,
  HANDLE_TAKEN,
  HANDLE_TOO_SOON,
  HANDLE_UNAVAILABLE,
  LOOT_BOSS,
  LOOT_DROP,
  LOOT_FEAT,
  LOOT_LEVEL,
  LOOT_SEASON,
  LOOT_SHOP,
  Reader,
  S2C,
  Writer,
  readBands,
  writeBands,
  writeFood,
  writeSnakeEntry,
  WARDROBE_NOT_FOR_SALE,
  WARDROBE_NOT_OWNED,
  WARDROBE_OK,
  WARDROBE_OWNED,
  WARDROBE_TOO_POOR,
  WARDROBE_TOO_SOON,
  WARDROBE_UNKNOWN,
  WARDROBE_WRONG_SLOT,
} from "../../src/game/protocol";
import { DailyBoard } from "./daily";
import { ProfileStore, rollLine, type Profile } from "./profiles";
import {
  DEFAULT_CUTOFFS,
  MODE_DOUBLE_REMAINS,
  MODE_HUNGER,
  MODE_TINY,
  UNLOCK_DEATH,
  UNLOCK_TRAIL,
  LEAGUES,
  LEAGUE_BANK_RUNS,
  type Cutoffs,
  isoWeek,
  leagueOf,
  nextStreak,
  rewardText,
  modeNow,
  seasonOf,
  todayUtc,
  type LifeStats,
} from "../../src/game/challenges";
import {
  NOTICE_LEVEL,
  NOTICE_XP,
  SCALES_BOSS,
  SCALES_CHEST,
  SCALES_QUEST,
  XP_ACHIEVEMENT,
  XP_BOSS_HIT,
  XP_BOSS_HITS_MAX,
  XP_BOSS_KILL,
  XP_BOSS_PART,
  XP_CHEST,
  XP_CONTRACT,
  XP_DAILY,
  XP_MARK,
  XP_QUEST,
  growthXp,
  killXp,
  levelOf,
  lifeScales,
} from "../../src/game/level";
import {
  RARITIES,
  SLOTS,
  cosmeticById,
  itemForFeat,
  itemsForLevel,
  loadoutOf,
  priceOf,
} from "../../src/game/cosmetics";
import { playGateFromEnv } from "./play-gate";
import { chosenHandle, cleanHandle, identityGateFromEnv, type Identity } from "./identity";
import { lifeFeats } from "../../src/game/achievements";
import {
  CONTRACT_FIRST_MS,
  CONTRACT_GAP_MS,
  CONTRACT_MIN_MASS,
  CONTRACT_RANGE,
  contractFair,
  contractReward,
  contractSecs,
  markReward,
} from "../../src/game/contracts";
import { ArenaHost } from "./arena-host";
import { EventLog } from "./events";
import { checkAgentPass, mintAgentPass } from "./agent-pass";

interface View {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
}

interface Client {
  ws: WebSocket;
  ip: string;
  msgWindow: number;
  msgCount: number;
  sid: string | null;
  name: string;
  skin: number;
  bands?: string[];
  view: View;
  known: Set<string>;
  /**
   * Known snakes whose next entry must be full again (a new name, a new
   * league). They stay known: a client only hears about a death or a
   * departure for a snake the server knows it holds, so forgetting one to
   * force a full entry left its body behind on that client's map whenever
   * it died or left the view before the next snapshot.
   */
  refresh: Set<string>;
  /** Orb ids the client holds. */
  sentFood: Set<number>;
  /** Per food cell in view: the stamp last synced and the ids the client holds there. */
  foodCells: Map<number, FoodCellSync>;
  /** Sequence number of the last input applied, echoed in snapshots. */
  seq: number;
  /** Newer protocol: device key present, gets STATS2/PROFILE/NEAR/EVENT. */
  v2: boolean;
  /**
   * Wire protocol version announced on the socket URL (`?v=2`). Fixed for
   * the whole connection, so the level byte after full snake entries is
   * written consistently from the first snapshot; `v2` (device key seen)
   * can only flip later, which would misalign snapshots sent before it.
   */
  proto: number;
  key: string;
  party: string;
  trail: number;
  deathFx: number;
  profile: Profile | null;
  life: Life | null;
  combo: { n: number; last: number };
  comebackUsed: boolean;
  deathAt: number;
  deathMass: number;
  bountied: boolean;
  lastEmote: number;
  /** Afterlife between lives: a wisp that banks starting length. */
  wisp: { x: number; y: number; angle: number; boost: boolean; until: number; bank: number } | null;
  wispBank: number;
  /** Consecutive lives that ended inside 20 s; two in a row means a rough start. */
  rough: number;
  /** Boss hits landed this Boss Hour, for the participation chest. */
  bossHits: number;
  /** Input fingerprint for automated-play detection. */
  fp: { lastAt: number; lastAngle: number; n: number; sumDt: number; sumDt2: number; same: number };
  lastPing: number;
  alive: boolean;
  /** For the session event: when the socket opened and how many lives it played. */
  connectedAt: number;
  lives: number;
  /** A successful Turnstile redemption authorizes respawns until this time. */
  verifiedUntil: number;
  /** The linked account behind this socket, once a ticket has been redeemed. */
  account: Identity | null;
  /** A ticket redemption in flight, so a HELLO arriving meanwhile waits for it. */
  linking: Promise<void> | null;
  /** Site tickets this socket has tried to redeem. */
  linkTries: number;
  /** When the player last asked for a handle that reached the database. */
  lastHandleAt: number;
  /** When the last wardrobe request was handled. */
  lastWardrobeAt: number;
  /** When this socket last asked to spawn. */
  lastSpawnAt: number;
  /** When any message last arrived; 0 until the first. */
  lastSeenAt: number;
  /** The wire id of the snake that ended the last life, for a rematch; 0 for a wall or nobody. */
  killerNid: number;
  /** The food cells synced last time (null forces a full walk) and the change counter then. */
  foodRect: { gx0: number; gx1: number; gy0: number; gy1: number } | null;
  foodSeq: number;
  /** Carried a valid agent pass on its URL: one of the owner's headless clients. */
  trusted: boolean;
  /** The contract this player is hunting, the mark on them, and contracts filled in a row. */
  hunt: Hunt | null;
  mark: Mark | null;
  huntStreak: number;
  /** When the last hunt ended, so the next offer waits its gap. */
  huntEndedAt: number;
}

/** A contract to take a snake down before a deadline. */
interface Hunt {
  targetSid: string;
  targetName: string;
  until: number;
  reward: number;
}

/** A mark on a player: someone has a contract on them until the deadline. */
interface Mark {
  hunterSid: string;
  hunterName: string;
  until: number;
  reward: number;
}

interface FoodCellSync {
  gx: number;
  gy: number;
  /** World stamp of the cell when it was last synced; -1 means never. */
  stamp: number;
  ids: number[];
}

/** What the current life has done so far, for challenges and the profile. */
interface Life {
  startAt: number;
  near: number;
  remains: number;
  boosted: boolean;
  noboostLength: number;
  bounty: number;
  /** League tier index the snake has reached this life (from the week best at spawn). */
  tier: number;
  /** Contracts filled and marks outlived this life. */
  contracts: number;
  marks: number;
  /** Length at spawn and the peak since, for growth XP, and how much growth is booked. */
  startMass: number;
  peak: number;
  xpGrowth: number;
  /** The life's experience by source and the scales it paid, for the death card. */
  xp: Record<XpPart, number>;
  scales: number;
}

type XpPart = "growth" | "kills" | "contracts" | "boss" | "other" | "rested";

interface Token {
  sid: string;
  /** The process that minted it; only a token from another process rebuilds a snake. */
  instance: string;
  mass: number;
  x: number;
  y: number;
  angle: number;
  skin: number;
  name: string;
  kills: number;
  exp: number;
  /** Carries human verification across a short reconnect or instance hop. */
  humanExp?: number;
}

/** Compact wire shape: TOKEN messages use an 8-bit string length. */
interface WireToken {
  s: string;
  /** Minting instance (absent in tokens from before it was recorded). */
  i?: string;
  m: number;
  x: number;
  y: number;
  a: number;
  k: number;
  n: string;
  z: number;
  e: number;
  h?: number;
}

const VIEW_MARGIN = 220;
const MAX_NAME = 16;
const TOKEN_TTL_MS = 60_000;
const IDLE_STOP_MS = 30_000;

const MAX_CONNS_PER_IP = 4;
const CONNECTS_PER_MINUTE = 20;
const MAX_MSGS_PER_SECOND = 60;
const HEAT_DECAY_MS = 10 * 60_000;
const HOT_THRESHOLD = 3;
/** How long a redeemed identity ticket is trusted without asking the site again. */
const IDENTITY_TTL_MS = 10 * 60_000;
const IDENTITY_CACHE_MAX = 5000;
/** Handle requests that reach the database are spaced at least this far apart per socket. */
const HANDLE_COOLDOWN_MS = 1000;
/** A socket may ask to spawn at most this often; a flood would otherwise cost a placement and a rank query each. */
const SPAWN_MIN_MS = 400;
/** Site tickets a socket may try to redeem; each is a request to the site. */
const LINK_TRIES_MAX = 5;
/** Public page answers kept in memory. */
const HTTP_CACHE_MAX = 500;
/**
 * A client that stops reading is not fed forever: past the first mark its
 * per-tick messages are skipped, past the second it is cut off. Snapshots
 * at 30 Hz would otherwise pile up in the socket without bound.
 */
const SEND_SKIP_BYTES = 256 * 1024;
const SEND_CLOSE_BYTES = 4 * 1024 * 1024;
/** A socket that has said nothing for this long, or never introduced itself within the shorter, is closed. */
const IDLE_SOCKET_MS = 60_000;
const HELLO_DEADLINE_MS = 15_000;
/** The largest screen a view is believed for, in CSS pixels; the view a client reports is clamped to it at its zoom. */
const SCREEN_MAX_W = 3840;
const SCREEN_MAX_H = 2160;
/** While alive, the view centre may sit at most this fraction of the half view away from the head. */
const VIEW_DRIFT = 0.35;
/**
 * Notice kinds beyond the feed line (0), bounty (1), reward (2) and comeback
 * (3): a promotion for the promoted player alone (the client draws the
 * moment itself from the league byte), and a roll card at 10 plus the tier.
 */
const NOTICE_PROMOTED = 4;
/** The killer just took down their nemesis: the client shows it in the kill slot. */
const NOTICE_PAYBACK = 5;
/** Contracts: offered, filled, missed; a mark on you; a mark outlived. */
const NOTICE_HUNT = 6;
const NOTICE_HUNT_DONE = 7;
const NOTICE_HUNT_FAILED = 8;
const NOTICE_MARKED = 9;
const NOTICE_MARK_SURVIVED = 16;
const NOTICE_ROLL = 10;
/**
 * The view rectangle a client may ask for, in world units from its centre.
 * There is no player zoom; the camera follows snake size down to a scale of
 * 0.48, so an honest client on the widest common screens (3440 by 1440, or
 * 4K at device pixel ratio 1) asks for at most about 3600 by 2300.
 */
const VIEW_MAX_HW = 3800;
const VIEW_MAX_HH = 2400;

/** A finite number from the wire, or the fallback for NaN and infinities. */
function finite(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Players this process admits. The default was measured against a Vercel
 * Sandbox; a home arena on a desktop core sets ARENA_CAPACITY higher, and
 * the coordinator reads the value each arena reports rather than assuming.
 */
function capacityFromEnv(): number {
  const n = Number(process.env.ARENA_CAPACITY);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : MAX_PLAYERS_PER_INSTANCE;
}

/** First-life helper bots beyond the scaled bot count; past this, newcomers get none. */
const HELPER_BOT_SLACK = 6;
/** Orbs one food sync may add; a cell cut short is finished on the next one. */
const FOOD_ADD_CAP = 1500;

function sanitizeName(raw: string): string {
  const s = raw
    .replace(/[^\p{L}\p{N} _.\-']/gu, "")
    .trim()
    .slice(0, MAX_NAME);
  return cleanName(s) || "anon";
}

/**
 * Cloudflare's client header is honoured only behind the tunnel a home
 * arena runs through (`TRUST_CF_CONNECTING_IP=1` in its env). Anywhere
 * else any client could send it and choose its own address, slipping the
 * per-address caps and the play ticket's binding.
 */
const TRUST_CF_IP = process.env.TRUST_CF_CONNECTING_IP === "1";

function clientIp(req: IncomingMessage): string {
  if (TRUST_CF_IP) {
    const cloudflare = req.headers["cf-connecting-ip"];
    if (typeof cloudflare === "string" && cloudflare.trim()) return cloudflare.trim();
  }
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

/** A header against the game secret, in constant time. */
function sameSecret(given: string | string[] | undefined, secret: string): boolean {
  if (!secret || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Keep the process up through anything a tick, a socket or a database
 * round trip throws: an arena that dies takes every player with it. Errors
 * are logged, never swallowed silently.
 */
export function guardProcess(): void {
  process.on("unhandledRejection", (err) => {
    console.error("[server] unhandled rejection:", (err as Error)?.stack ?? err);
  });
  process.on("uncaughtException", (err) => {
    console.error("[server] uncaught exception:", err?.stack ?? err);
  });
}

async function readJson(req: IncomingMessage, maxBytes = 4096): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request too large");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid json");
  return value as Record<string, unknown>;
}

function sanitizeBands(bands: string[] | undefined): string[] | undefined {
  if (!bands) return undefined;
  const ok = bands.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, MAX_CUSTOM_BANDS);
  return ok.length ? ok : undefined;
}

export class GameServer {
  readonly world = new World(true);
  readonly instance =
    process.env.ARENA_NAME ??
    `${process.env.VERCEL_DEPLOYMENT_ID ?? "local"}-${randomBytes(3).toString("hex")}`;
  /** Set once an old arena has been told to hand its players to the coordinator. */
  private draining = false;
  readonly capacity = capacityFromEnv();
  private readonly secret = process.env.GAME_SECRET ?? randomBytes(32).toString("hex");
  private readonly playGate = playGateFromEnv(this.secret);
  private readonly identity = identityGateFromEnv();
  /** Redeemed tickets, so a reconnect or an arena hop does not call the site again. */
  private readonly identities = new Map<string, { id: Identity; at: number }>();
  private readonly clients = new Set<Client>();
  /**
   * Clients whose socket closed while their snake lives on in the grace
   * window, by snake id. The life is booked on the profile when the snake
   * dies, and carried on when a reconnect reattaches it.
   */
  private readonly detached = new Map<string, Client>();
  private readonly nids = new Map<string, number>();
  private readonly grace = new Map<string, NodeJS.Timeout>();
  private readonly daily = new DailyBoard();
  private readonly profiles = new ProfileStore();
  private readonly host = new ArenaHost(this.profiles.db, process.env);
  /** What players do, for the metrics readout; nothing is kept without a database. */
  private readonly events = new EventLog(this.profiles.db, this.instance);
  private readonly parties = new Map<string, Set<string>>();
  private bountyOf = new Map<string, number>();
  private event: { x: number; y: number; until: number } | null = null;
  /** Outbound buffers for the per-tick messages; `finish` copies, so they are reused. */
  private readonly outSnap = new Writer();
  private readonly outAdd = new Writer();
  private readonly outDel = new Writer();
  private readonly connsByIp = new Map<string, number>();
  private readonly connectLog = new Map<string, number[]>();
  /** Death sites by coarse cell with timestamps, for spawn placement. */
  private readonly heat = new Map<number, number[]>();
  /** Token signatures already redeemed, so a token cannot be replayed. */
  private readonly usedTokens = new Map<string, number>();
  /**
   * Player snakes that died here, by id, until every token minted for them
   * has expired: a token kept from before a death must not bring the snake
   * back at its old length.
   */
  private readonly deadSids = new Map<string, number>();
  /** Live snakes by id, rebuilt each tick: the per-client loops look snakes up by sid. */
  private readonly bySid = new Map<string, Snake>();
  /** The season's league cutoffs (see `cutoffsFrom`), refreshed from the profiles every few minutes. */
  private cutoffs: Cutoffs = DEFAULT_CUTOFFS;
  private cutoffsAt = 0;
  private nextNid = 1;
  private nextPlayer = 1;
  private tick = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastActivity = Date.now();
  private startedAt = Date.now();
  private stepMs = 0;
  private loopMs = 0;
  private tickErrors = 0;
  private tickErrorLogAt = 0;
  /** Set once a tick's deaths were announced and booked; a tick that throws before that hands them back. */
  private deathsBooked = true;
  private wss: WebSocketServer | null = null;

  constructor() {
    this.world.host = true;
    this.world.resetLocalBots(SERVER_BOTS);
    for (const s of this.world.snakes) this.nidOf(s.id);
    void this.refreshCutoffs();
  }

  private async refreshCutoffs(): Promise<void> {
    this.cutoffsAt = Date.now();
    try {
      this.cutoffs = await this.profiles.leagueCutoffs();
    } catch (err) {
      console.error("[leagues] cutoffs failed:", (err as Error)?.message ?? err);
    }
  }

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, maxPayload: 4096 });
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
    server.on("request", (req, res) => {
      if (req.headers.upgrade) return;
      this.onHttpRequest(req, res).catch((err: unknown) => {
        console.error("[http] failed:", (err as Error)?.message ?? err);
        if (!res.headersSent) res.statusCode = 500;
        if (!res.writableEnded) res.end(JSON.stringify({ ok: false }));
      });
    });
  }

  private async onHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("content-type", "application/json");
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");

    const url = new URL(req.url ?? "/", "http://arena.local");
    const path = url.pathname;
    if (path === "/api/arena") {
      if (url.searchParams.get("tick")) {
        const r = await this.host.tick().catch((e: Error) => ({ error: e.message }));
        res.end(JSON.stringify({ ok: true, ...r }));
        return;
      }
      const party = (url.searchParams.get("with") ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
      try {
        const pick = await this.host.resolve(party);
        res.setHeader("cache-control", "no-store");
        if (!pick) {
          // A plain 200 so the browser console stays clean on local servers.
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        res.end(JSON.stringify({ ok: true, ...pick }));
      } catch (e) {
        res.statusCode = 503;
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
      return;
    }
    const metricsDays = url.searchParams.get("metrics");
    if (metricsDays !== null) {
      const secret = process.env.GAME_SECRET ?? "";
      if (!sameSecret(req.headers["x-game-secret"], secret)) {
        res.statusCode = 403;
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.setHeader("cache-control", "no-store");
      const days = Math.min(90, Math.max(1, Math.floor(Number(metricsDays)) || 7));
      const m = await this.events.metrics(days);
      if (!m) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: "no database" }));
        return;
      }
      res.end(JSON.stringify({ ok: true, ...m }));
      return;
    }
    if (path === "/api/drain") {
      const secret = process.env.GAME_SECRET ?? "";
      if (!sameSecret(req.headers["x-game-secret"], secret)) {
        res.statusCode = 403;
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      this.drain();
      res.end(JSON.stringify({ ok: true, drained: this.clients.size }));
      return;
    }
    // Public pages are answered from a short memory cache: an arena serves
    // them straight off its own process, so a hammered handle must not turn
    // into a database query per request.
    const handle = url.searchParams.get("profile");
    if (handle !== null) {
      res.setHeader("cache-control", "public, max-age=15");
      const h = cleanHandle(handle);
      const hit = await this.cachedJson(`profile:${h}`, 15_000, async () => {
        const p = h ? await this.profiles.byHandle(h) : null;
        if (!p) return { status: 404, body: JSON.stringify({ ok: false }) };
        const [rank, rarity] = await Promise.all([this.profiles.rank(p), this.profiles.rarity()]);
        return {
          status: 200,
          body: JSON.stringify({
            ok: true,
            profile: this.profiles.publicProfile(p, rank),
            rarity,
            cutoffs: this.cutoffs,
          }),
        };
      });
      res.statusCode = hit.status;
      res.end(hit.body);
      return;
    }
    const top = url.searchParams.get("top");
    if (top === "alltime" || top === "weekly" || top === "season" || top === "crew") {
      res.setHeader("cache-control", "public, max-age=30");
      const hit = await this.cachedJson(`top:${top}`, 30_000, async () => {
        try {
          const rows =
            top === "crew" ? await this.profiles.topCrews(50) : await this.profiles.top(top, 100);
          return {
            status: 200,
            body: JSON.stringify({
              kind: top,
              week: isoWeek(),
              season: seasonOf(),
              rows,
              cutoffs: this.cutoffs,
            }),
          };
        } catch {
          return { status: 200, body: JSON.stringify({ kind: top, rows: [] }) };
        }
      });
      res.statusCode = hit.status;
      res.end(hit.body);
      return;
    }
    // Vercel rewrites /api/play-ticket to the /api/ws function. POST is not
    // otherwise used on /api/ws, so accept either URL inside that function.
    const isPlayTicket =
      path === "/api/play-ticket" || (path === "/api/ws" && req.method === "POST");
    const isPlayTicketPreflight =
      path === "/api/play-ticket" || (path === "/api/ws" && req.method === "OPTIONS");
    if (!isPlayTicket && !isPlayTicketPreflight) {
      if (url.searchParams.get("whoami")) {
        // What this arena takes the caller's address to be, and from which
        // header: the per-address caps are only as good as this.
        res.setHeader("cache-control", "no-store");
        res.end(
          JSON.stringify({
            ip: clientIp(req),
            xff: req.headers["x-forwarded-for"] ?? null,
            xri: req.headers["x-real-ip"] ?? null,
            cf: req.headers["cf-connecting-ip"] ?? null,
            remote: req.socket.remoteAddress ?? null,
          }),
        );
        return;
      }
      res.end(JSON.stringify(this.status()));
      return;
    }
    res.setHeader("cache-control", "no-store");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.removeHeader("content-type");
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("allow", "POST, OPTIONS");
      res.end(JSON.stringify({ ok: false, error: "Method not allowed." }));
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "Invalid request." }));
      return;
    }
    const result = await this.playGate.issue(
      typeof body.turnstileToken === "string" ? body.turnstileToken : "",
      clientIp(req),
    );
    if (!result.ok) {
      res.statusCode = result.status;
      if (result.retryAfter) res.setHeader("retry-after", String(result.retryAfter));
      res.end(JSON.stringify({ ok: false, error: result.error }));
      return;
    }
    res.end(JSON.stringify({ ok: true, ticket: result.ticket, expiresAt: result.expiresAt }));
  }

  /** Answers to public page requests, by key, for a short while; bounded. */
  private readonly httpCache = new Map<string, { at: number; status: number; body: string }>();
  /** Answers being made, so a burst of the same request runs one query. */
  private readonly httpPending = new Map<string, Promise<{ status: number; body: string }>>();

  private async cachedJson(
    key: string,
    ttlMs: number,
    make: () => Promise<{ status: number; body: string }>,
  ): Promise<{ status: number; body: string }> {
    const now = Date.now();
    const hit = this.httpCache.get(key);
    if (hit && now - hit.at < ttlMs) return hit;
    const pending = this.httpPending.get(key);
    if (pending) return pending;
    const task = make().finally(() => this.httpPending.delete(key));
    this.httpPending.set(key, task);
    const made = await task;
    this.httpCache.set(key, { at: now, ...made });
    while (this.httpCache.size > HTTP_CACHE_MAX) {
      const oldest = this.httpCache.keys().next().value;
      if (oldest === undefined) break;
      this.httpCache.delete(oldest);
    }
    return made;
  }

  status(): Record<string, unknown> {
    const snakes = this.world.snakes;
    return {
      ok: true,
      instance: this.instance,
      draining: this.draining,
      coordinator: this.host.enabled,
      players: snakes.filter((s) => !s.isBot).length,
      bots: snakes.filter((s) => s.isBot).length,
      clients: this.clients.size,
      foods: this.world.foods.length,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      tick: this.tick,
      stepMs: Math.round(this.stepMs * 100) / 100,
      capacity: this.capacity,
      loopMs: Math.round(this.loopMs * 100) / 100,
      playGate: this.playGate.enabled,
      hot: this.hotSpots(12),
      daily: this.daily.top(3),
      events: {
        enabled: this.events.enabled,
        buffered: this.events.buffered,
        dropped: this.events.dropped,
      },
    };
  }

  /** The busiest death cells, as cell centres. */
  private hotSpots(n: number): { x: number; y: number; deaths: number }[] {
    const now = Date.now();
    const out: { x: number; y: number; deaths: number }[] = [];
    for (const [key, times] of this.heat) {
      const recent = times.filter((t) => now - t < HEAT_DECAY_MS);
      if (!recent.length) continue;
      out.push({ ...hotCellCentre(key), deaths: recent.length });
    }
    return out.sort((a, b) => b.deaths - a.deaths).slice(0, n);
  }

  private recordDeath(x: number, y: number): void {
    const key = hotKey(x, y);
    const now = Date.now();
    const times = (this.heat.get(key) ?? []).filter((t) => now - t < HEAT_DECAY_MS);
    times.push(now);
    this.heat.set(key, times);
    if (times.length >= HOT_THRESHOLD) this.world.hot.add(key);
  }

  private decayHeat(): void {
    const now = Date.now();
    for (const [key, times] of this.heat) {
      const recent = times.filter((t) => now - t < HEAT_DECAY_MS);
      if (recent.length) this.heat.set(key, recent);
      else this.heat.delete(key);
      if (recent.length < HOT_THRESHOLD) this.world.hot.delete(key);
    }
  }

  /** Drop per-address and per-ticket records that have aged out, so a long-lived arena stays flat. */
  private pruneCaches(): void {
    const now = Date.now();
    for (const [ip, times] of this.connectLog) {
      if (times.every((t) => now - t >= 60_000)) this.connectLog.delete(ip);
    }
    for (const [key, hit] of this.identities) {
      if (now - hit.at >= IDENTITY_TTL_MS) this.identities.delete(key);
    }
    for (const [sig, exp] of this.usedTokens) if (exp < now) this.usedTokens.delete(sig);
    for (const [sid, exp] of this.deadSids) if (exp < now) this.deadSids.delete(sid);
  }

  /** The connected client that owns a snake, if any. */
  private clientBySid(sid: string): Client | null {
    for (const c of this.clients) if (c.sid === sid) return c;
    return null;
  }

  /** The client behind a snake: connected, or gone with the snake still in its grace window. */
  private ownerOf(sid: string): Client | null {
    return this.clientBySid(sid) ?? this.detached.get(sid) ?? null;
  }

  /** Profile keys held by connected clients and by snakes still in their grace window. */
  private profilesInUse(): Set<string> {
    const keys = new Set<string>();
    for (const c of this.clients) if (c.profile) keys.add(c.profile.key);
    for (const c of this.detached.values()) if (c.profile) keys.add(c.profile.key);
    return keys;
  }

  /** Take a snake out of its party, and forget the party once it is empty. */
  private leaveParty(code: string, sid: string): void {
    const set = this.parties.get(code);
    if (!set) return;
    set.delete(sid);
    if (!set.size) this.parties.delete(code);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  private ensureLoop(): void {
    if (this.timer) return;
    let last = Date.now();
    let acc = 0;
    const dt = 1 / SERVER_TICK_HZ;
    this.timer = setInterval(() => {
      const now = Date.now();
      const t0 = performance.now();
      acc += Math.min(0.25, (now - last) / 1000);
      last = now;
      let steps = 0;
      try {
        while (acc >= dt && steps < 4) {
          this.step(dt);
          acc -= dt;
          steps++;
        }
      } catch (err) {
        // One bad tick must not take the arena down with it; the next tick
        // starts from a clean accumulator, and the fault is logged, throttled.
        // Deaths the tick had not booked yet are handed back to the next one.
        acc = 0;
        if (!this.deathsBooked) this.world.requeueDeaths();
        this.tickErrors++;
        if (now - this.tickErrorLogAt > 1000) {
          this.tickErrorLogAt = now;
          console.error(`[tick] failed (${this.tickErrors} so far):`, (err as Error)?.stack ?? err);
        }
      }
      if (acc > dt * 2) acc = dt;
      // Whole interval cost: simulation plus every client's broadcast.
      this.loopMs = this.loopMs * 0.9 + (performance.now() - t0) * 0.1;
      if (this.clients.size === 0 && now - this.lastActivity > IDLE_STOP_MS) this.stopLoop();
    }, 1000 / SERVER_TICK_HZ);
  }

  private stopLoop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Stop the loop, drop pending timers and close every socket (tests, orderly shutdown). */
  close(): void {
    this.stopLoop();
    for (const t of this.grace.values()) clearTimeout(t);
    this.grace.clear();
    this.detached.clear();
    for (const c of this.clients) c.ws.close(1001, "server closing");
    this.wss?.close();
    this.wss = null;
  }

  private nidOf(sid: string): number {
    let n = this.nids.get(sid);
    if (n === undefined) {
      const taken = new Set(this.nids.values());
      do {
        n = this.nextNid++;
        if (this.nextNid > 65000) this.nextNid = 1;
      } while (taken.has(n));
      this.nids.set(sid, n);
    }
    return n;
  }

  // ── connections ────────────────────────────────────────────────────────────

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = clientIp(req);
    // Wire protocol the client speaks: 2 adds a level byte to full entries,
    // 3 adds league and might bytes and a league byte per board row, 4 the
    // finish byte, 5 a level byte and a flags byte (crown, linked) per board row.
    const params = new URL(req.url ?? "/", "http://x").searchParams;
    const asked = Number(params.get("v"));
    const proto = Number.isFinite(asked) ? Math.max(1, Math.min(6, Math.floor(asked))) : 1;
    // The owner's headless agents carry a signed pass: no per-address caps, no human gate.
    const trusted = checkAgentPass(params.get("agent"), process.env.AGENT_SECRET || this.secret);
    const now = Date.now();
    const recent = (this.connectLog.get(ip) ?? []).filter((t) => now - t < 60_000);
    // Loopback is exempt from the per-address caps so local load tests can
    // open hundreds of sockets. Judged from the socket itself, never from a
    // header a client could set. Only admitted sockets are counted: a
    // client turned away keeps retrying, and counting the refusals kept it
    // locked out for as long as it tried. The owner's agents count for
    // nothing, so they cannot fill anyone's quota.
    const peer = req.socket.remoteAddress ?? "";
    const local = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    if (
      !local &&
      !trusted &&
      (recent.length >= CONNECTS_PER_MINUTE || (this.connsByIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP)
    ) {
      ws.close(1008, "too many connections");
      return;
    }
    if (!trusted) {
      recent.push(now);
      this.connectLog.set(ip, recent);
    }
    // The coordinator function never hosts a game while it knows a live
    // arena: a socket landing here skipped or lost the lookup and would be
    // alone on this instance. FULL with a one second retry makes the client
    // ask the coordinator again. With nothing known yet, warm the caches for
    // the next socket and host this one.
    if (this.host.enabled) {
      if (this.host.knownArena()) {
        ws.send(new Writer().u8(S2C.FULL).u16(1).finish());
        ws.close(1013, "join the arena");
        return;
      }
      void this.host.resolve("").catch(() => undefined);
    }
    // A full instance turns newcomers away with a retry hint; on a platform
    // that scales instances by concurrency the retry lands elsewhere.
    if (this.draining) {
      ws.send(new Writer().u8(S2C.FULL).u16(1).finish());
      ws.close(1013, "arena draining");
      return;
    }
    if (this.clients.size >= this.capacity) {
      ws.send(
        new Writer()
          .u8(S2C.FULL)
          .u16(3 + Math.floor(Math.random() * 4))
          .finish(),
      );
      ws.close(1013, "arena full");
      return;
    }
    if (!trusted) this.connsByIp.set(ip, (this.connsByIp.get(ip) ?? 0) + 1);
    const client: Client = {
      ws,
      ip,
      msgWindow: now,
      msgCount: 0,
      sid: null,
      name: "anon",
      skin: 0,
      view: { cx: 0, cy: 0, hw: 900, hh: 600 },
      known: new Set(),
      refresh: new Set(),
      sentFood: new Set(),
      foodCells: new Map(),
      seq: 0,
      v2: false,
      proto,
      key: "",
      party: "",
      trail: 0,
      deathFx: 0,
      profile: null,
      life: null,
      combo: { n: 0, last: 0 },
      comebackUsed: false,
      deathAt: 0,
      deathMass: 0,
      bountied: false,
      lastEmote: 0,
      wisp: null,
      wispBank: 0,
      rough: 0,
      bossHits: 0,
      fp: { lastAt: 0, lastAngle: 0, n: 0, sumDt: 0, sumDt2: 0, same: 0 },
      lastPing: Date.now(),
      connectedAt: now,
      lives: 0,
      alive: true,
      verifiedUntil: 0,
      account: null,
      linking: null,
      linkTries: 0,
      lastHandleAt: 0,
      lastWardrobeAt: 0,
      lastSpawnAt: 0,
      lastSeenAt: 0,
      killerNid: 0,
      foodRect: null,
      foodSeq: -1,
      trusted,
      hunt: null,
      mark: null,
      huntStreak: 0,
      huntEndedAt: 0,
    };
    this.clients.add(client);
    this.lastActivity = Date.now();
    this.ensureLoop();
    ws.binaryType = "arraybuffer";
    ws.on("message", (data) => this.onMessage(client, data));
    ws.on("close", () => this.onClose(client));
    ws.on("error", () => this.onClose(client));
    ws.send(
      new Writer()
        .u8(S2C.WELCOME)
        .str(this.instance)
        .f32(ARENA_RADIUS)
        .u8(SERVER_TICK_HZ)
        .u8(client.proto)
        .finish(),
    );
  }

  private onClose(client: Client): void {
    if (!client.alive) return;
    client.alive = false;
    this.clients.delete(client);
    if (!client.trusted) {
      const n = (this.connsByIp.get(client.ip) ?? 1) - 1;
      if (n <= 0) this.connsByIp.delete(client.ip);
      else this.connsByIp.set(client.ip, n);
    }
    this.lastActivity = Date.now();
    if (client.key)
      this.events.log("session_end", {
        key: client.key,
        n: Math.round((Date.now() - client.connectedAt) / 1000),
        meta: { lives: client.lives },
      });
    const sid = client.sid;
    client.sid = null;
    // A hunt ends with the socket, quietly; whoever it marked has outlived it.
    client.hunt = null;
    client.mark = null;
    if (sid) this.settleMarksBy(sid);
    if (!sid) return;
    if (client.party) this.leaveParty(client.party, sid);
    // Hold the snake for a moment so a reconnect (forced by the platform's
    // connection cap, or a flaky network) can pick it back up. The client
    // record is kept with it: a snake that dies in the window still ends a
    // life, and the profile must hear about it.
    const input = this.world.inputs.get(sid);
    if (input) input.boost = false;
    this.detached.set(sid, client);
    this.grace.set(
      sid,
      setTimeout(() => {
        this.grace.delete(sid);
        this.world.killSnake(sid);
      }, DISCONNECT_GRACE_MS),
    );
  }

  private onMessage(client: Client, data: RawData): void {
    if (!client.alive) return;
    const now = Date.now();
    client.lastSeenAt = now;
    if (now - client.msgWindow > 1000) {
      client.msgWindow = now;
      client.msgCount = 0;
    }
    if (++client.msgCount > MAX_MSGS_PER_SECOND) {
      client.ws.close(1008, "too fast");
      return;
    }
    let buf: Uint8Array;
    if (data instanceof ArrayBuffer) buf = new Uint8Array(data);
    else if (Array.isArray(data)) buf = new Uint8Array(Buffer.concat(data));
    else buf = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (!buf.byteLength) return;
    const r = new Reader(buf);
    try {
      const type = r.u8();
      if (type === C2S.HELLO || type === C2S.SPAWN)
        void this.onHello(client, r, type === C2S.SPAWN).catch((err) => {
          console.error("[hello] failed:", (err as Error)?.message ?? err);
        });
      else if (type === C2S.INPUT) this.onInput(client, r);
      else if (type === C2S.EMOTE) this.onEmote(client, r.u8());
      else if (type === C2S.CREW) this.onCrew(client, r.str());
      else if (type === C2S.WARDROBE) this.onWardrobe(client, r);
      else if (type === C2S.HANDLE)
        void this.onSetHandle(client, r.str()).catch((err) => {
          console.error("[handle] failed:", (err as Error)?.message ?? err);
        });
      else if (type === C2S.IDENT)
        void this.onIdent(client, r).catch((err) => {
          console.error("[ident] failed:", (err as Error)?.message ?? err);
        });
      else if (type === C2S.PING) client.ws.send(new Writer().u8(S2C.PONG).u32(r.u32()).finish());
    } catch {
      client.ws.close(1003, "bad message");
    }
  }

  private async onHello(client: Client, r: Reader, respawn: boolean): Promise<void> {
    const asked = Date.now();
    if (asked - client.lastSpawnAt < SPAWN_MIN_MS) return;
    client.lastSpawnAt = asked;
    client.name = sanitizeName(r.str());
    // A linked player is named by their handle, whatever the client sent.
    if (client.account && client.profile?.handle) client.name = `@${client.profile.handle}`;
    const look = unpackSkin(r.u8());
    client.skin = look.skin;
    client.bands = sanitizeBands(readBands(r));
    const tokenText = r.remaining ? r.str() : "";
    // v2 clients append: device key, death effect, party code, comeback flag.
    let comeback = false;
    let playTicket = "";
    let nearNid = 0;
    if (r.remaining) {
      client.v2 = true;
      const key = r
        .str()
        .replace(/[^A-Za-z0-9_-]/g, "")
        .slice(0, 64);
      // Once linked the key is the account's; the device key is not written over it.
      if (!client.account) client.key = key;
      client.deathFx = r.remaining ? r.u8() : 0;
      client.party = r.remaining
        ? r
            .str()
            .replace(/[^A-Za-z0-9]/g, "")
            .slice(0, 12)
        : "";
      comeback = r.remaining ? r.u8() === 1 : false;
      if (client.key && !client.profile)
        client.profile = await this.profiles.load(client.key, client.name);
      if (!client.alive) return;
      // The identify message may have arrived before the nickname was known.
      if (client.profile && !client.account) this.profiles.setName(client.profile, client.name);
      const unlocks = client.profile?.unlocks ?? 0;
      client.trail =
        look.trail < UNLOCK_TRAIL.length &&
        (look.trail === 0 || unlocks & UNLOCK_TRAIL[look.trail]!)
          ? look.trail
          : 0;
      client.deathFx =
        client.deathFx < UNLOCK_DEATH.length &&
        (client.deathFx === 0 || unlocks & UNLOCK_DEATH[client.deathFx]!)
          ? client.deathFx
          : 0;
      playTicket = r.remaining ? r.str() : "";
      // Rematch: spawn near this snake if it is still alive.
      nearNid = r.remaining >= 2 ? r.u16() : 0;
      // Account link: the site's origin and a ticket it minted for this player.
      const idOrigin = r.remaining ? r.str().slice(0, 200) : "";
      const idTicket = r.remaining ? r.str().slice(0, 128) : "";
      if (idOrigin && idTicket && !respawn) {
        await this.linkAccount(client, idOrigin, idTicket);
        if (!client.alive) return;
      }
    }
    if (client.sid && this.world.snakes.some((s) => s.id === client.sid && s.alive)) {
      // Already playing: a repeated hello just updates the look next spawn,
      // and a respawn request ends the current life first so no snake is
      // left running unowned.
      if (!respawn) return;
      const old = this.world.snakes.find((s) => s.id === client.sid);
      this.world.killSnake(client.sid);
      if (old) this.endLife(client, old, false);
      client.sid = null;
    }
    // Whatever spawns next, the afterlife is over.
    if (client.wisp) this.endWisp(client);
    // Check the signed resume token before consuming it: a verified session
    // must survive the platform moving a socket to another server instance.
    const resume = tokenText && !respawn ? this.verifyToken(tokenText) : null;
    if (resume?.humanExp && resume.humanExp > Date.now()) {
      client.verifiedUntil = resume.humanExp;
    }
    if (this.playGate.enabled && client.verifiedUntil <= Date.now() && !client.trusted) {
      const verifiedUntil = this.playGate.redeem(playTicket, client.ip);
      if (!verifiedUntil) {
        client.ws.send(
          new Writer()
            .u8(S2C.GATE_REQUIRED)
            .str("Complete human verification before joining the arena.")
            .finish(),
        );
        return;
      }
      client.verifiedUntil = verifiedUntil;
    }
    // A token kept from before a death, or one from this very process whose
    // snake is simply gone, buys nothing: only a hop from another arena
    // rebuilds a snake from a token.
    const dead = resume ? this.deadSids.has(resume.sid) : false;
    if (dead) this.events.log("feature", { key: client.key, s: "dead_token" });
    const token = resume && !dead ? this.redeemToken(tokenText) : null;
    const now = Date.now();
    let snake: Snake | null = null;
    let spawnKind = "fresh";
    // The life so far of a reattached snake, so a reconnect does not restart
    // the clock on "survive five minutes" or forget a boost.
    let resumed: Life | null = null;
    if (token) {
      const held = this.world.snakes.find((s) => s.id === token.sid && s.alive);
      const timer = this.grace.get(token.sid);
      const owner = held ? this.clientBySid(held.id) : null;
      if (held && (timer || (owner && owner !== client))) {
        // Reattach. If another socket still owns the snake (the old
        // connection has not closed yet), ownership moves here rather than a
        // second copy being built.
        if (timer) clearTimeout(timer);
        this.grace.delete(token.sid);
        const left = this.detached.get(token.sid);
        this.detached.delete(token.sid);
        spawnKind = "resume";
        const previous = owner && owner !== client ? owner : left;
        if (previous) {
          resumed = previous.life;
          previous.life = null;
        }
        if (owner && owner !== client) owner.sid = null;
        snake = held;
        snake.skin = client.skin;
        snake.bands = client.bands;
      } else if (token.instance === this.instance) {
        // Our own token for a snake that is no longer here: it died or was
        // replaced, so this is a fresh life like any other.
        snake = this.world.spawnSnake(this.newSid(), client.name, client.skin, false, client.bands);
        if (client.profile) this.profiles.setLook(client.profile, client.skin, client.bands);
        this.events.log("feature", { key: client.key, s: "stale_token" });
      } else {
        // The snake lived on another instance: rebuild it with the same
        // length near where it was.
        spawnKind = "rebuild";
        const at = this.world.safeSpawnNear({ x: token.x, y: token.y });
        snake = this.world.spawnSnake(
          this.newSid(),
          client.name,
          client.skin,
          false,
          client.bands,
          token.mass,
        );
        snake.x = at.x;
        snake.y = at.y;
        snake.points = [];
        this.world.ensureTrail(snake);
        snake.kills = token.kills;
      }
    } else {
      // A comeback keeps a quarter of the lost length, once per connection,
      // if asked for within a few seconds of dying.
      let mass: number | undefined;
      if (
        respawn &&
        comeback &&
        modeNow().id !== MODE_TINY &&
        !client.comebackUsed &&
        client.deathAt &&
        now - client.deathAt < COMEBACK_WINDOW_MS
      ) {
        mass = Math.max(START_MASS + 1, Math.floor(client.deathMass * COMEBACK_KEEP));
        client.comebackUsed = true;
        spawnKind = "comeback";
        this.events.log("feature", { key: client.key, s: "comeback", n: mass });
        if (client.profile && this.profiles.award(client.profile, "comeback"))
          this.achieve(client, "comeback");
      }
      snake = this.world.spawnSnake(
        this.newSid(),
        client.name,
        client.skin,
        false,
        client.bands,
        mass,
      );
      if (client.profile) this.profiles.setLook(client.profile, client.skin, client.bands);
      if (mass === undefined && client.wispBank > 0) {
        snake.mass = START_MASS + client.wispBank;
        snake.points = [];
        this.world.ensureTrail(snake);
      }
      client.wispBank = 0;
      // Skill-based placement: veterans start out where the big snakes roam,
      // newcomers in the quietest corner the arena has. A party overrides it.
      const best = client.profile?.best ?? 0;
      const selfId = snake.id;
      // A rematch spawns beside the snake that ended the last life, and only
      // that one, only for a while: anything else would be a way to land next
      // to whoever you pick.
      const rival =
        nearNid && nearNid === client.killerNid && now - client.deathAt < COMEBACK_WINDOW_MS
          ? this.world.snakes.find(
              (s) => s.alive && s.id !== selfId && this.nidOf(s.id) === nearNid,
            )
          : undefined;
      if (rival) {
        this.spawnNearSnake(snake, rival);
        spawnKind = "rematch";
      } else if (client.rough >= 2) {
        // Two quick deaths in a row: the quiet corner and a helper again.
        this.spawnQuiet(snake);
        this.spawnHelperBot(snake);
      } else if (best >= 500) this.spawnNearTop(snake);
      else if (best < 100) this.spawnQuiet(snake);
      // A first life gets a small, timid bot placed just ahead: the easiest
      // possible first kill, which is what turns a visitor into a player.
      if (client.profile && client.profile.games === 0) this.spawnHelperBot(snake);
      // Friends spawn together: near any live member of the same party.
      const mate = client.party ? this.partyMember(client.party, snake.id) : null;
      if (mate) {
        const at = this.world.safeSpawnNear({ x: mate.x, y: mate.y });
        snake.x = at.x;
        snake.y = at.y;
        snake.angle = mate.angle;
        snake.points = [];
        this.world.ensureTrail(snake);
      }
    }
    // The same dressing whether the snake is new, rebuilt or reattached, so a
    // reconnect never drops the crew tag, crown or badge.
    snake.name = client.profile?.crew ? `[${client.profile.crew}] ${client.name}` : client.name;
    snake.crown = Boolean(client.profile && client.profile.crownUntil > now);
    snake.linked = Boolean(client.account);
    // Rookies (best under 100) and anyone on a rough start get gentler bots.
    snake.rookie = (client.profile?.best ?? 0) < 100 || client.rough >= 2;
    snake.trail = client.trail;
    snake.deathFx = client.deathFx;
    if (client.profile) {
      // Time away since the profile was last seen becomes rested XP, and
      // levels reached but never paid (the migration, a missed moment) pay now.
      this.profiles.touchRested(client.profile, now);
      const owed = this.profiles.claimTrack(client.profile);
      if (owed)
        this.notice(
          client,
          0,
          `level ${levelOf(client.profile.xp)} · +${owed} scales for the levels so far`,
        );
      const pieces = this.profiles.claimItems(client.profile);
      for (const id of pieces) this.sendLoot(client, id, lootSourceOf(id), 0);
      if (pieces.length) {
        this.notice(client, 0, `wardrobe: ${pieces.map(pieceName).join(", ")} earned`);
        this.sendWardrobe(client, WARDROBE_OK);
      }
    }
    snake.level = client.profile ? levelOf(client.profile.xp) : 0;
    snake.loadout = loadoutOf(client.profile?.equipped);
    snake.league = client.profile ? leagueOf(client.profile.weekBest, this.cutoffs) + 1 : 0;
    snake.might = client.profile ? Object.keys(client.profile.achv).length : 0;
    snake.finish = client.profile?.prevTier ?? 0;
    client.sid = snake.id;
    client.life = resumed ?? {
      startAt: Date.now(),
      near: 0,
      remains: 0,
      boosted: false,
      noboostLength: snake.mass,
      bounty: 0,
      tier: leagueOf(client.profile?.weekBest ?? 0, this.cutoffs),
      contracts: 0,
      marks: 0,
      startMass: snake.mass,
      peak: snake.mass,
      xpGrowth: 0,
      xp: { growth: 0, kills: 0, contracts: 0, boss: 0, other: 0, rested: 0 },
      scales: 0,
    };
    client.combo = { n: 0, last: 0 };
    client.bountied = false;
    if (client.party) {
      let set = this.parties.get(client.party);
      if (!set) this.parties.set(client.party, (set = new Set()));
      set.add(snake.id);
    }
    this.world.inputs.set(snake.id, { angle: snake.angle, boost: false });
    this.world.nearIds.add(snake.id);
    const nid = this.nidOf(snake.id);
    client.ws.send(
      new Writer()
        .u8(S2C.SPAWNED)
        .u16(nid)
        .f32(snake.x)
        .f32(snake.y)
        .angle(snake.angle)
        .f32(snake.mass)
        .finish(),
    );
    this.sendToken(client);
    client.lives++;
    this.events.log("spawn", {
      key: client.key,
      s: spawnKind,
      n: Math.round(snake.mass),
      meta: { party: Boolean(client.party), rookie: Boolean(snake.rookie) },
    });
    if (client.v2) {
      void this.sendProfile(client);
      if (this.event && this.event.until > Date.now()) this.sendEvent(client);
    }
  }

  /** Set (or clear) the crew tag shown before the name. */
  private onCrew(client: Client, raw: string): void {
    if (!client.profile) return;
    const tag = raw
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 4);
    if (tag && (tag.length < 2 || !cleanName(tag))) return;
    this.profiles.setCrew(client.profile, tag);
    this.events.log("feature", { key: client.key, s: tag ? "crew" : "crew_leave" });
    void this.sendProfile(client);
  }

  /** Broadcast a reaction above a live snake to everyone who can see it. */
  private onEmote(client: Client, id: number): void {
    if (!client.sid || id > 3) return;
    const now = Date.now();
    if (now - client.lastEmote < 1500) return;
    client.lastEmote = now;
    this.events.log("feature", { key: client.key, s: "emote", n: id });
    const msg = new Writer().u8(S2C.EMOTE).u16(this.nidOf(client.sid)).u8(id).finish();
    for (const c of this.clients)
      if (c.v2 && (c.known.has(client.sid) || c === client)) c.ws.send(msg);
  }

  /**
   * A v2 client introducing itself before playing: load its profile, link
   * the account when the site's origin and ticket ride along, and send the
   * profile. The client sends it again once a ticket minted after the
   * socket opened arrives, so the menu shows the account before the first life.
   */
  private async onIdent(client: Client, r: Reader): Promise<void> {
    const key = r
      .str()
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 64);
    const name = sanitizeName(r.remaining ? r.str() : "anon");
    const idOrigin = r.remaining ? r.str().slice(0, 200) : "";
    const idTicket = r.remaining ? r.str().slice(0, 128) : "";
    if (!key) return;
    client.v2 = true;
    if (!client.key) this.events.log("session_start", { key, meta: { proto: client.proto } });
    // Once linked the key is the account's; a repeated introduction keeps it.
    if (!client.account) client.key = key;
    if (!client.profile) client.profile = await this.profiles.load(key, name);
    if (!client.alive) return;
    if (idOrigin && idTicket) {
      await this.linkAccount(client, idOrigin, idTicket);
      if (!client.alive) return;
    }
    void this.sendProfile(client);
    if (this.event && this.event.until > Date.now()) this.sendEvent(client);
  }

  /**
   * Put the account behind a site ticket on this socket: the profile becomes
   * the account's and the name its handle. A second call while one is in
   * flight (IDENT then HELLO) waits for the first instead of racing it.
   */
  private linkAccount(client: Client, origin: string, ticket: string): Promise<void> {
    if (client.account) return Promise.resolve();
    if (client.linking) return client.linking;
    if (client.linkTries >= LINK_TRIES_MAX) return Promise.resolve();
    client.linkTries++;
    const task = (async () => {
      const id = await this.redeemIdentity(origin, ticket);
      if (!client.alive || !id) return;
      client.account = id;
      client.profile = await this.profiles.link(client.profile, id, client.name);
      if (!client.alive) return;
      client.key = client.profile.key;
      client.name = `@${client.profile.handle}`;
      this.events.log("feature", { key: client.key, s: "link" });
      if (this.profiles.award(client.profile, "linked")) this.achieve(client, "linked");
    })().finally(() => {
      client.linking = null;
    });
    client.linking = task;
    return task;
  }

  /**
   * A linked player choosing the handle they are named by. Checked here,
   * claimed on the profile (which keeps it across sign-ins), and applied to
   * the live snake at once; the answer carries a status the menu can explain.
   */
  private async onSetHandle(client: Client, raw: string): Promise<void> {
    const reply = (status: number): void => {
      if (!client.alive) return;
      client.ws.send(
        new Writer()
          .u8(S2C.HANDLE)
          .u8(status)
          .str(client.profile?.handle ?? "")
          .finish(),
      );
    };
    const p = client.profile;
    if (!client.account || !p || !p.sub) return reply(HANDLE_NOT_LINKED);
    const h = chosenHandle(raw);
    if (!h || !cleanName(h)) return reply(HANDLE_INVALID);
    const now = Date.now();
    if (now - client.lastHandleAt < HANDLE_COOLDOWN_MS) return reply(HANDLE_TOO_SOON);
    client.lastHandleAt = now;
    let result: "ok" | "taken";
    try {
      result = await this.profiles.claimHandle(p, h);
    } catch (err) {
      console.error("[handle] claim failed:", (err as Error)?.message ?? err);
      return reply(HANDLE_UNAVAILABLE);
    }
    if (!client.alive) return;
    if (result === "taken") return reply(HANDLE_TAKEN);
    client.name = `@${h}`;
    const s = client.sid ? this.world.snakes.find((x) => x.id === client.sid) : undefined;
    if (s) {
      s.name = p.crew ? `[${p.crew}] ${client.name}` : client.name;
      // Every client gets a full entry again, with the new name.
      for (const o of this.clients) o.refresh.add(s.id);
    }
    this.events.log("feature", { key: client.key, s: "handle" });
    reply(HANDLE_OK);
    void this.sendProfile(client);
  }

  private spawnHelperBot(snake: Snake): void {
    // Helpers are extra bots. Without a ceiling a wave of newcomers doubled
    // the bot population and the world's cost with it.
    let bots = 0;
    for (const s of this.world.snakes) if (s.isBot && s.alive) bots++;
    if (bots >= this.world.desiredBots + HELPER_BOT_SLACK) return;
    const used = new Set(this.world.snakes.map((s) => s.name.toLowerCase()));
    const bot = this.world.spawnBot(used);
    bot.mass = 14;
    bot.temper = 0;
    bot.angle = snake.angle;
    const at = {
      x: snake.x + Math.cos(snake.angle) * 420 + Math.cos(snake.angle + Math.PI / 2) * 60,
      y: snake.y + Math.sin(snake.angle) * 420 + Math.sin(snake.angle + Math.PI / 2) * 60,
    };
    this.moveSnake(bot, at);
    this.nidOf(bot.id);
  }

  private moveSnake(snake: Snake, at: { x: number; y: number }): void {
    snake.x = at.x;
    snake.y = at.y;
    snake.points = [];
    this.world.ensureTrail(snake);
  }

  /** A rematch: 600 to 900 units from the chosen rival, facing them. */
  private spawnNearSnake(snake: Snake, t: Snake): void {
    const a = Math.random() * Math.PI * 2;
    const d = 600 + Math.random() * 300;
    const at = this.world.safeSpawnNear({ x: t.x + Math.cos(a) * d, y: t.y + Math.sin(a) * d });
    this.moveSnake(snake, at);
    snake.angle = Math.atan2(t.y - at.y, t.x - at.x);
  }

  private spawnNearTop(snake: Snake): void {
    const top = this.world.snakes
      .filter((s) => s.alive && s.id !== snake.id)
      .sort((a, b) => b.mass - a.mass)
      .slice(0, 5);
    if (!top.length) return;
    const t = top[(Math.random() * top.length) | 0]!;
    const a = Math.random() * Math.PI * 2;
    const d = 700 + Math.random() * 500;
    this.moveSnake(
      snake,
      this.world.safeSpawnNear({ x: t.x + Math.cos(a) * d, y: t.y + Math.sin(a) * d }),
    );
  }

  private spawnQuiet(snake: Snake): void {
    let best: { x: number; y: number } | null = null;
    let bestD = -1;
    for (let i = 0; i < 8; i++) {
      const p = this.world.randomOpenPoint();
      let near = Infinity;
      for (const o of this.world.snakes) {
        if (!o.alive || o.id === snake.id) continue;
        const d = Math.hypot(o.x - p.x, o.y - p.y);
        if (d < near) near = d;
      }
      if (near > bestD) {
        bestD = near;
        best = p;
      }
    }
    if (best) this.moveSnake(snake, best);
  }

  private partyMember(code: string, exceptSid: string): Snake | null {
    const set = this.parties.get(code);
    if (!set) return null;
    for (const sid of set) {
      if (sid === exceptSid) continue;
      const s = this.world.snakes.find((x) => x.id === sid && x.alive);
      if (s) return s;
    }
    return null;
  }

  private async sendProfile(client: Client): Promise<void> {
    try {
      await this.sendProfileNow(client);
    } catch (err) {
      console.error("[profile] send failed:", (err as Error)?.message ?? err);
    }
  }

  private async sendProfileNow(client: Client): Promise<void> {
    const p = client.profile;
    if (!p || !client.alive) return;
    const rank = await this.profiles.rank(p);
    if (!client.alive) return;
    // What today's first life does to the streak, and whether it is played:
    // the client cannot tell from the streak alone.
    const streak = nextStreak(p.streak, p.streakLast, p.freezes, todayUtc());
    const nemesis = this.profiles.nemesisOf(p);
    client.ws.send(
      new Writer()
        .u8(S2C.PROFILE)
        .u32(p.best)
        .u32(p.kills)
        .u32(p.games)
        .u32(p.survive)
        .u32(rank)
        .u32(p.unlocks)
        .u8(this.profiles.persistent ? 1 : 0)
        .f32(p.bestX)
        .f32(p.bestY)
        .u8(Math.min(255, p.weekDone))
        .u8(p.earned.includes(p.week) ? 1 : 0)
        .u32(p.weekBest)
        .u16(Math.min(65535, p.streak))
        .u8(Math.min(255, p.freezes))
        .u8(p.prevTier)
        .u32(p.eaten)
        .u32(p.nearTotal)
        .u16(Math.min(65535, p.bountyTotal))
        .u32(p.seasonBest)
        .u16(p.season)
        .u8(Math.min(255, p.shards))
        .str(p.crew)
        .u16(Math.max(0, Math.min(65535, Math.ceil((p.crownUntil - Date.now()) / 1000))))
        .u16(Math.min(65535, p.chests))
        .str(p.handle)
        .u8(p.sub ? 1 : 0)
        .str(Object.keys(p.achv).join(","))
        .u8(p.bankedTier)
        .u8(Math.min(255, p.weekLives))
        .u8(Math.min(255, p.weekRuns[0] ?? 0))
        .u8(Math.min(255, p.weekRuns[1] ?? 0))
        .u8(Math.min(255, p.weekRuns[2] ?? 0))
        .u8(Math.min(255, p.weekRuns[3] ?? 0))
        .u8(Math.min(255, p.weekRuns[4] ?? 0))
        .u8(p.seasonTier)
        .str(p.seasons.map(([season, tier]) => `${season}:${tier}`).join(","))
        .u16(Math.min(65535, streak.streak))
        .u8(streak.playedToday ? 1 : 0)
        .str(nemesis?.name ?? "")
        .u8(Math.min(255, nemesis?.k ?? 0))
        .u8(Math.min(255, nemesis?.d ?? 0))
        .u32(p.xp)
        .u32(p.rested)
        .u32(p.scales)
        .finish(),
    );
    const list = this.profiles.challenges(p);
    const w = new Writer().u8(S2C.CHALLENGES).u8(list.length);
    for (const c of list)
      w.u8(c.challenge.id)
        .str(c.challenge.text)
        .u32(c.challenge.target)
        .u32(c.progress)
        .u8(c.done ? 1 : 0);
    client.ws.send(w.finish());
    this.sendWardrobe(client, WARDROBE_OK);
    // Rewards a week or season roll queued are told now, while the player is looking.
    const pending = this.profiles.drainPending(p);
    for (const line of pending.lines) {
      // A roll card: kind 10 plus the tier, which the menu shows until it is
      // dismissed. Older clients show any kind they do not know as a feed line.
      const { tier, text } = rollLine(line);
      this.notice(client, NOTICE_ROLL + Math.min(LEAGUES.length, tier), text);
      this.events.log("reward", { key: client.key, s: text.slice(0, 80) });
    }
    for (const id of pending.achv) this.achieve(client, id);
  }

  private sendWisp(c: Client, secsLeft: number): void {
    const w = c.wisp;
    if (!w) return;
    c.ws.send(
      new Writer()
        .u8(S2C.WISP)
        .f32(w.x)
        .f32(w.y)
        .u16(Math.round(w.bank))
        .u8(Math.max(0, Math.min(255, Math.ceil(secsLeft))))
        .finish(),
    );
  }

  private endWisp(c: Client): void {
    const w = c.wisp;
    if (!w) return;
    c.wispBank = Math.min(WISP_BANK_MAX, Math.round(w.bank));
    this.events.log("feature", { key: c.key, s: "wisp", n: c.wispBank });
    this.sendWisp(c, 0);
    c.wisp = null;
  }

  /** Move every wisp, let it eat, and end the ones that have run out. */
  private stepWisps(dt: number): void {
    const now = Date.now();
    for (const c of this.clients) {
      const w = c.wisp;
      if (!w) continue;
      // Out of time, or the bank is full: the wisp ends at once either way.
      if (now >= w.until || w.bank >= WISP_BANK_MAX) {
        if (w.bank >= WISP_BANK_MAX && c.profile && this.profiles.award(c.profile, "afterlife"))
          this.achieve(c, "afterlife");
        this.endWisp(c);
        continue;
      }
      moveWisp(w, w.boost, dt);
      slideAlongRim(w);
      if (w.bank >= WISP_BANK_MAX) continue;
      // Everything but chase and event orbs, anywhere inside the halo.
      for (const f of this.world.queryFood(w.x, w.y, WISP_REACH + 12)) {
        if (f.k > 2 || f.id === undefined) continue;
        if (Math.hypot(f.x - w.x, f.y - w.y) > WISP_REACH + f.r) continue;
        w.bank = Math.min(WISP_BANK_MAX, w.bank + f.v);
        this.world.removeFood(f);
        if (w.bank >= WISP_BANK_MAX) break;
      }
    }
  }

  private boss: Snake | null = null;
  private bossHour = -1;
  private bossUntil = 0;

  /** The Boss Hour: at :30 every hour a boss surfaces at a landmark for five minutes. */
  private stepBoss(): void {
    const now = new Date();
    const hour = now.getUTCHours();
    if (this.boss && (!this.boss.alive || Date.now() > this.bossUntil)) {
      if (this.boss.alive) this.world.killSnake(this.boss.id);
      this.boss = null;
      for (const c of this.clients) c.bossHits = 0;
    }
    // The boss surfaces any time in its window once someone is connected,
    // not only at the exact minute, and always leaves at the window's end.
    const minute = now.getUTCMinutes();
    const windowStart = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hour,
      BOSS_MINUTE,
    );
    if (
      !this.boss &&
      minute >= BOSS_MINUTE &&
      minute < BOSS_MINUTE + BOSS_DURATION_S / 60 &&
      this.bossHour !== hour &&
      this.clients.size
    ) {
      this.bossHour = hour;
      const lm = LANDMARKS[(hour + 1) % LANDMARKS.length]!;
      const at = this.world.safeSpawnNear({ x: lm.x, y: lm.y });
      const boss = this.world.spawnBoss(at);
      this.boss = boss;
      this.nidOf(boss.id);
      this.bossUntil = windowStart + BOSS_DURATION_S * 1000;
      for (const c of this.clients)
        this.notice(c, 0, `${BOSS_NAME} has surfaced at ${lm.name}: cut it together`);
    }
    if (!this.world.bossHits.length) return;
    for (const h of this.world.bossHits) {
      const c = this.clientBySid(h.attacker);
      if (!c) continue;
      c.bossHits++;
      if (c.bossHits <= XP_BOSS_HITS_MAX) this.grantXp(c, XP_BOSS_HIT, "boss");
      this.events.log("feature", {
        key: c.key,
        s: h.killed ? "boss_kill" : h.kind === "ram" ? "boss_ram" : "boss_hit",
      });
      if (!h.killed) continue;
      this.grantXp(c, XP_BOSS_KILL, "boss");
      // The final cut wears the crown until the next boss; everyone who hit it gets a chest.
      if (c.profile) {
        this.profiles.setCrown(c.profile, Date.now() + 3600_000);
        if (this.profiles.award(c.profile, "boss_slayer")) this.achieve(c, "boss_slayer");
        void this.sendProfile(c);
      }
      const me = this.world.snakes.find((s) => s.id === c.sid);
      if (me) me.crown = true;
      for (const o of this.clients) {
        this.notice(o, 0, `${c.name} landed the final cut on ${BOSS_NAME} and wears the crown`);
        if (o.bossHits > 0 && o.profile) {
          this.notice(o, 2, this.profiles.openChest(o.profile));
          this.events.log("feature", { key: o.key, s: "chest" });
          this.grantXp(o, XP_CHEST, "other");
          if (o !== c) this.grantXp(o, XP_BOSS_PART, "boss");
          this.profiles.addScales(o.profile, SCALES_BOSS);
          void this.sendProfile(o);
        }
        o.bossHits = 0;
      }
    }
    this.world.bossHits.length = 0;
  }

  /** Hand every player to the coordinator: FULL with a one second retry, then close. */
  private drain(): void {
    this.draining = true;
    for (const c of this.clients) {
      try {
        c.ws.send(new Writer().u8(S2C.FULL).u16(1).finish());
        c.ws.close(1013, "arena draining");
      } catch {
        /* already gone */
      }
    }
  }

  /** Tell a v2 client it just earned an achievement. */
  private achieve(client: Client, id: string, life: Life | null = client.life): void {
    this.events.log("achievement", { key: client.key, s: id });
    this.grantXp(client, XP_ACHIEVEMENT, "other", life);
    // Some feats carry a wardrobe piece.
    const piece = itemForFeat(id);
    if (piece && client.profile && this.profiles.grantFresh(client.profile, piece.id)) {
      this.sendLoot(client, piece.id, LOOT_FEAT, 0);
      this.sendWardrobe(client, WARDROBE_OK);
    }
    if (!client.v2 || !client.alive) return;
    client.ws.send(new Writer().u8(S2C.ACHIEVE).str(id).finish());
  }

  /** Redeem a site ticket, remembering the answer for a while. */
  private async redeemIdentity(origin: string, ticket: string): Promise<Identity | null> {
    const k = `${origin}|${ticket}`;
    const hit = this.identities.get(k);
    if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.id;
    const id = await this.identity.redeem(origin, ticket);
    if (id) {
      // Entries are only ever appended, so insertion order is age order and
      // the first key is the oldest.
      this.identities.delete(k);
      this.identities.set(k, { id, at: Date.now() });
      while (this.identities.size > IDENTITY_CACHE_MAX) {
        const oldest = this.identities.keys().next().value;
        if (oldest === undefined) break;
        this.identities.delete(oldest);
      }
    }
    return id;
  }

  /** A wardrobe request: equip (1), unequip (2) or buy (3) a piece. */
  private onWardrobe(client: Client, r: Reader): void {
    const op = r.u8();
    const slotIdx = r.u8();
    const id = r.remaining
      ? r
          .str()
          .replace(/[^a-z0-9_]/g, "")
          .slice(0, 32)
      : "";
    const p = client.profile;
    if (!p || !client.v2) return;
    const now = Date.now();
    if (now - client.lastWardrobeAt < 250) {
      this.sendWardrobe(client, WARDROBE_TOO_SOON);
      return;
    }
    client.lastWardrobeAt = now;
    const slot = SLOTS[slotIdx];
    const piece = cosmeticById(id);
    let status = WARDROBE_OK;
    if (op === 1) {
      if (!slot || !piece) status = WARDROBE_UNKNOWN;
      else if (piece.slot !== slot) status = WARDROBE_WRONG_SLOT;
      else if (!this.profiles.equip(p, slot, id)) status = WARDROBE_NOT_OWNED;
    } else if (op === 2) {
      if (!slot) status = WARDROBE_UNKNOWN;
      else this.profiles.equip(p, slot, null);
    } else if (op === 3) {
      const res = this.profiles.buy(p, id);
      status =
        res === "ok"
          ? WARDROBE_OK
          : res === "too_poor"
            ? WARDROBE_TOO_POOR
            : res === "owned"
              ? WARDROBE_OWNED
              : WARDROBE_NOT_FOR_SALE;
      if (res === "ok" && piece) {
        this.sendLoot(client, id, LOOT_SHOP, 0);
        this.events.log("feature", { key: client.key, s: "buy", n: priceOf(piece) });
      }
    } else status = WARDROBE_UNKNOWN;
    if (status === WARDROBE_OK && op !== 3) this.redress(client);
    this.sendWardrobe(client, status);
    if (op === 3 && status === WARDROBE_OK) void this.sendProfile(client);
  }

  /** The live snake wears what the profile has on; everyone gets its full entry again. */
  private redress(client: Client): void {
    const s = client.sid ? this.bySid.get(client.sid) : undefined;
    if (!s) return;
    s.loadout = loadoutOf(client.profile?.equipped);
    for (const o of this.clients) o.refresh.add(s.id);
  }

  /** What is on and what is owned, for clients that know the wardrobe. */
  private sendWardrobe(client: Client, status: number): void {
    const p = client.profile;
    if (!p || client.proto < 6 || !client.alive) return;
    const w = new Writer().u8(S2C.WARDROBE).u8(status);
    for (const slot of SLOTS) w.str(p.equipped[slot] ?? "");
    const owned = Object.keys(p.wardrobe).slice(0, 65535);
    w.u16(owned.length);
    for (const id of owned) w.str(id);
    client.ws.send(w.finish());
  }

  /** A piece arriving, or the scales paid instead when it was already owned. */
  private sendLoot(client: Client, id: string, source: number, scales: number): void {
    const c = cosmeticById(id);
    if (!c) return;
    this.events.log("feature", {
      key: client.key,
      s: scales ? "loot_dup" : "loot",
      meta: { id, source },
    });
    if (client.proto < 6 || !client.alive) return;
    client.ws.send(
      new Writer()
        .u8(S2C.LOOT)
        .str(id)
        .u8(Math.max(0, RARITIES.indexOf(c.rarity)))
        .u8(source)
        .u16(Math.min(65535, scales))
        .finish(),
    );
  }

  private notice(client: Client, kind: number, text: string): void {
    if (!client.v2 || !client.alive) return;
    client.ws.send(new Writer().u8(S2C.NOTICE).u8(kind).str(text).finish());
  }

  private sendEvent(client: Client): void {
    if (!this.event || !client.v2) return;
    const left = Math.max(0, Math.round((this.event.until - Date.now()) / 1000));
    client.ws.send(
      new Writer().u8(S2C.EVENT).f32(this.event.x).f32(this.event.y).u16(left).finish(),
    );
  }

  private newSid(): string {
    return `p${this.nextPlayer++}`;
  }

  private onInput(client: Client, r: Reader): void {
    // New clients prefix a sequence number; older ones (still deployed on
    // the platform frontend) do not. Tell them apart by length.
    if (r.remaining >= 21) client.seq = r.u16();
    const angle = r.angle();
    const boost = r.u8() === 1;
    // Floats off the wire can be NaN or infinite; such a view would silently
    // stop every snapshot, so keep the previous one instead.
    const v = client.view;
    const view = {
      cx: finite(r.f32(), v.cx),
      cy: finite(r.f32(), v.cy),
      hw: Math.min(VIEW_MAX_HW, Math.max(0, finite(r.f32(), v.hw))),
      hh: Math.min(VIEW_MAX_HH, Math.max(0, finite(r.f32(), v.hh))),
    };
    // A live snake's view is its own screen: no wider than the largest
    // screen shows at this length's zoom, and centred near the head. Anything
    // else is a look around the arena nobody else gets, and a way to make
    // the server resend the world every snapshot.
    const me = client.sid ? this.liveSnake(client.sid) : null;
    if (me) {
      const z = zoomOf(me.mass);
      view.hw = Math.min(view.hw, SCREEN_MAX_W / (2 * z) + 40);
      view.hh = Math.min(view.hh, SCREEN_MAX_H / (2 * z) + 40);
      const dx = view.hw * VIEW_DRIFT;
      const dy = view.hh * VIEW_DRIFT;
      view.cx = Math.min(me.x + dx, Math.max(me.x - dx, view.cx));
      view.cy = Math.min(me.y + dy, Math.max(me.y - dy, view.cy));
    }
    client.view = view;
    const lag = r.remaining >= 1 ? (r.u8() * 4) / 1000 : 0;
    this.fingerprint(client, angle);
    if (!client.sid) {
      if (client.wisp) {
        client.wisp.angle = angle;
        client.wisp.boost = boost;
      }
      return;
    }
    const input = this.world.inputs.get(client.sid);
    if (input) {
      input.angle = angle;
      input.boost = boost;
    }
    this.world.lags.set(client.sid, lag);
  }

  /**
   * Automated play leaves a signature a hand on a mouse does not: input
   * timing with almost no jitter beyond the client's own throttle, and a
   * heading that is either frozen or changes every single message. Over a
   * long window both together flag the profile, which keeps it off the
   * leaderboard page. Nothing about play itself changes.
   */
  private fingerprint(client: Client, angle: number): void {
    const fp = client.fp;
    const now = performance.now();
    if (fp.lastAt) {
      const dt = now - fp.lastAt;
      fp.n++;
      fp.sumDt += dt;
      fp.sumDt2 += dt * dt;
      if (Math.abs(angle - fp.lastAngle) < 1e-4) fp.same++;
    }
    fp.lastAt = now;
    fp.lastAngle = angle;
    if (fp.n >= 1800) {
      const mean = fp.sumDt / fp.n;
      const varc = Math.max(0, fp.sumDt2 / fp.n - mean * mean);
      const cv = Math.sqrt(varc) / Math.max(1, mean);
      const sameRatio = fp.same / fp.n;
      // Real browsers show timing jitter well above 1% even on a throttle;
      // a scripted sender at a fixed interval sits far below it.
      if (cv < 0.01 && (sameRatio > 0.97 || sameRatio < 0.03) && client.profile) {
        this.profiles.flag(client.profile);
        console.warn(
          `[anticheat] flagged ${client.name} (cv ${cv.toFixed(4)}, same ${sameRatio.toFixed(2)})`,
        );
      }
      client.fp = { lastAt: now, lastAngle: angle, n: 0, sumDt: 0, sumDt2: 0, same: 0 };
    }
  }

  // ── tokens ─────────────────────────────────────────────────────────────────

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  private makeToken(s: Snake, humanExp?: number): string {
    const t: WireToken = {
      s: s.id,
      i: this.instance,
      m: Math.round(s.mass * 10) / 10,
      x: Math.round(s.x),
      y: Math.round(s.y),
      a: Math.round(s.angle * 1000) / 1000,
      k: s.skin,
      n: s.name,
      z: s.kills,
      e: Date.now() + TOKEN_TTL_MS,
      ...(humanExp && Number.isFinite(humanExp) ? { h: humanExp } : {}),
    };
    const payload = Buffer.from(JSON.stringify(t)).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  /** Verify a token and mark it spent; a replayed token is refused. */
  private redeemToken(text: string): Token | null {
    const t = this.verifyToken(text);
    if (!t) return null;
    const sig = text.slice(text.indexOf(".") + 1);
    if (this.usedTokens.has(sig)) return null;
    this.usedTokens.set(sig, t.exp);
    return t;
  }

  private verifyToken(text: string): Token | null {
    const dot = text.indexOf(".");
    if (dot < 0) return null;
    const payload = text.slice(0, dot);
    const sigBuf = Buffer.from(text.slice(dot + 1));
    const expectBuf = Buffer.from(this.sign(payload));
    if (sigBuf.length !== expectBuf.length || !timingSafeEqual(sigBuf, expectBuf)) return null;
    try {
      const raw = JSON.parse(Buffer.from(payload, "base64url").toString()) as Token | WireToken;
      const t: Token =
        "s" in raw
          ? {
              sid: raw.s,
              instance: typeof raw.i === "string" ? raw.i : "",
              mass: raw.m,
              x: raw.x,
              y: raw.y,
              angle: raw.a,
              skin: raw.k,
              name: raw.n,
              kills: raw.z,
              exp: raw.e,
              humanExp: raw.h,
            }
          : raw;
      if (typeof t.sid !== "string" || typeof t.mass !== "number" || typeof t.exp !== "number")
        return null;
      if (!Number.isFinite(t.mass) || t.exp < Date.now()) return null;
      // A rebuilt snake is placed from these; a NaN would put it nowhere,
      // where nothing can ever touch it.
      if (![t.x, t.y, t.angle].every(Number.isFinite)) return null;
      // Tokens are signed, so this is sanity only; long runs really do reach
      // a few hundred thousand.
      t.mass = Math.min(t.mass, 2_000_000);
      t.kills = Number.isFinite(t.kills) ? Math.max(0, Math.floor(t.kills)) : 0;
      return t;
    } catch {
      return null;
    }
  }

  /**
   * A live snake by id. The index is rebuilt each tick, so a snake spawned
   * since (a spawn happens on a message, between ticks) is looked up the
   * slow way once.
   */
  private liveSnake(sid: string): Snake | null {
    const hit = this.bySid.get(sid);
    if (hit && hit.alive) return hit;
    return this.world.snakes.find((s) => s.id === sid && s.alive) ?? null;
  }

  private sendToken(client: Client): void {
    if (!client.sid) return;
    const s = this.liveSnake(client.sid);
    if (!s) return;
    client.ws.send(
      new Writer().u8(S2C.TOKEN).str(this.makeToken(s, client.verifiedUntil)).finish(),
    );
  }

  // ── simulation and broadcast ───────────────────────────────────────────────

  private step(dt: number): void {
    const t0 = performance.now();
    this.tick++;
    this.deathsBooked = false;
    this.world.step(dt, 0, 0, false);
    this.stepMs = this.stepMs * 0.95 + (performance.now() - t0) * 0.05;
    this.bySid.clear();
    for (const s of this.world.snakes) {
      if (s.alive) this.bySid.set(s.id, s);
      if (!this.nids.has(s.id)) this.nidOf(s.id);
    }

    if (this.world.deaths.length) this.onDeaths();
    this.deathsBooked = true;
    this.stepWisps(dt);
    if (this.tick % SERVER_TICK_HZ === 0) this.stepBoss();
    if (this.world.eats.length) this.onEats();
    if (this.world.nears.length) this.onNears();
    this.trackLives();
    if (this.tick % (SERVER_TICK_HZ * SWARM_EVERY_S) === 0 && this.clients.size) this.startSwarm();

    // Under load: fewer bots as players fill the arena, and snapshots at
    // 20 Hz instead of 30 when a step is getting expensive.
    if (this.tick % SERVER_TICK_HZ === 0) {
      this.dropIdleSockets();
      // Bots scale down by attrition: over the target none respawns, and
      // none is ever killed by the server, so a bot only dies the way a
      // snake dies, by driving into something.
      const players = this.clients.size;
      this.world.desiredBots = Math.max(SERVER_BOTS_MIN, SERVER_BOTS - Math.floor(players * 0.6));
      this.checkPromotions();
      this.stepContracts(Date.now());
      const mode = modeNow().id;
      this.world.remainsMult = mode === MODE_DOUBLE_REMAINS ? 2 : 1;
      this.world.hunger = mode === MODE_HUNGER ? HUNGER_RATE : 0;
    }
    const heavy = this.stepMs > 6;
    const snapEvery = Math.max(1, Math.round(SERVER_TICK_HZ / (heavy ? 20 : SNAPSHOT_HZ)));
    const foodEvery = Math.max(1, Math.round(SERVER_TICK_HZ / FOOD_SYNC_HZ));
    if (this.tick % snapEvery === 0)
      for (const c of this.clients) if (this.canSend(c)) this.sendSnapshot(c);
    if (this.tick % foodEvery === 0)
      for (const c of this.clients) if (this.canSend(c)) this.sendFood(c);
    if (this.tick % Math.round(SERVER_TICK_HZ / 2) === 0) this.sendStatsAll();
    if (this.tick % SERVER_TICK_HZ === 0) for (const c of this.clients) this.sendToken(c);
    if (this.tick % (SERVER_TICK_HZ * 30) === 0) {
      this.decayHeat();
      this.pruneCaches();
      this.profiles.sweep(this.profilesInUse());
      if (Date.now() - this.cutoffsAt > 5 * 60_000) void this.refreshCutoffs();
    }
  }

  /**
   * A socket that never introduced itself, or has gone quiet, gives its slot
   * back: the arena admits a fixed number of sockets, and a silent one would
   * hold a place forever. A menu client pings every two seconds.
   */
  /** The idle limits, on the instance so a test can shorten them. */
  private idleSocketMs = IDLE_SOCKET_MS;
  private helloDeadlineMs = HELLO_DEADLINE_MS;

  private dropIdleSockets(): void {
    const now = Date.now();
    for (const c of this.clients) {
      const silent = now - (c.lastSeenAt || c.connectedAt) > this.idleSocketMs;
      const anonymous = !c.lastSeenAt && now - c.connectedAt > this.helloDeadlineMs;
      if (silent || anonymous) c.ws.close(1000, silent ? "idle" : "no hello");
    }
  }

  /** Is the socket keeping up? Skips a client that has fallen behind, drops one that has stopped reading. */
  private canSend(c: Client): boolean {
    const buffered = c.ws.bufferedAmount;
    if (buffered > SEND_CLOSE_BYTES) {
      c.ws.close(1008, "too slow");
      return false;
    }
    return buffered < SEND_SKIP_BYTES;
  }

  /**
   * Contracts, once a second: hunts past their clock are missed, marks past
   * theirs are outlived, and every eligible hunter without a contract is
   * offered one. See src/game/contracts.ts for the rules.
   */
  private stepContracts(now: number): void {
    for (const c of this.clients) {
      if (c.hunt && now >= c.hunt.until) this.endHunt(c, "expired");
      if (c.mark && now >= c.mark.until) this.settleMark(c, "survived");
    }
    for (const c of this.clients) {
      if (c.hunt || !c.sid || !c.life || !c.v2) continue;
      if (now - c.life.startAt < CONTRACT_FIRST_MS || now - c.huntEndedAt < CONTRACT_GAP_MS)
        continue;
      const me = this.liveSnake(c.sid);
      if (!me || me.mass < CONTRACT_MIN_MASS) continue;
      const target = this.pickTarget(c, me);
      if (target) this.assignHunt(c, me, target);
    }
  }

  /**
   * A contract's target: alive, near, a fair size, not protected, not a
   * rookie, not a party mate, not already hunted. Players before bots, one
   * of the three nearest at random.
   */
  private pickTarget(c: Client, me: Snake): Snake | null {
    const hunted = new Set<string>();
    for (const o of this.clients) if (o.hunt) hunted.add(o.hunt.targetSid);
    const mates = c.party ? this.parties.get(c.party) : undefined;
    const players: Snake[] = [];
    const bots: Snake[] = [];
    const range2 = CONTRACT_RANGE * CONTRACT_RANGE;
    for (const s of this.world.snakes) {
      if (!s.alive || s.id === me.id || s.boss || s.invuln > 0 || s.rookie) continue;
      if (hunted.has(s.id) || mates?.has(s.id)) continue;
      if (!contractFair(me.mass, s.mass)) continue;
      if (dist2(me.x, me.y, s.x, s.y) > range2) continue;
      (s.isBot ? bots : players).push(s);
    }
    const pool = players.length ? players : bots;
    if (!pool.length) return null;
    pool.sort((a, b) => dist2(me.x, me.y, a.x, a.y) - dist2(me.x, me.y, b.x, b.y));
    return pool[Math.floor(Math.random() * Math.min(3, pool.length))]!;
  }

  private assignHunt(c: Client, me: Snake, target: Snake): void {
    const secs = contractSecs(Math.sqrt(dist2(me.x, me.y, target.x, target.y)));
    const reward = contractReward(target.mass, c.huntStreak);
    const until = Date.now() + secs * 1000;
    c.hunt = { targetSid: target.id, targetName: target.name, until, reward };
    this.notice(c, NOTICE_HUNT, `contract · hunt ${target.name} · ${secs} s · +${reward}`);
    this.events.log("feature", {
      key: c.key,
      s: "contract",
      n: reward,
      meta: { bot: target.isBot },
    });
    // A hunted player is told, and paid for outliving the clock.
    const victim = target.isBot ? null : this.clientBySid(target.id);
    if (victim && victim.v2 && !victim.mark) {
      const mr = markReward(reward);
      victim.mark = { hunterSid: me.id, hunterName: me.name, until, reward: mr };
      this.notice(victim, NOTICE_MARKED, `marked by ${me.name} · survive ${secs} s · +${mr}`);
    }
  }

  /** A hunt ends: filled (paid, streak up), missed (streak lost) or void (the target went some other way). */
  private endHunt(c: Client, outcome: "done" | "expired" | "void"): void {
    const h = c.hunt;
    if (!h) return;
    c.hunt = null;
    c.huntEndedAt = Date.now();
    if (outcome === "done") {
      c.huntStreak++;
      if (c.life) c.life.contracts++;
      this.grantXp(c, XP_CONTRACT, "contracts");
      const me = c.sid ? this.liveSnake(c.sid) : null;
      if (me) me.mass += h.reward;
      const streak = c.huntStreak > 1 ? ` · streak ${c.huntStreak}` : "";
      this.notice(c, NOTICE_HUNT_DONE, `contract done · ${h.targetName} · +${h.reward}${streak}`);
      this.events.log("feature", { key: c.key, s: "contract_done", n: h.reward });
    } else if (outcome === "expired") {
      const had = c.huntStreak;
      c.huntStreak = 0;
      const lost = had > 1 ? ` · streak of ${had} lost` : "";
      this.notice(c, NOTICE_HUNT_FAILED, `contract expired · ${h.targetName}${lost}`);
      this.events.log("feature", { key: c.key, s: "contract_miss" });
    } else {
      this.notice(c, 0, `contract void · ${h.targetName} is gone`);
    }
  }

  /** A mark ends: outlived (paid) or not (the marked snake died; nothing to say, it knows). */
  private settleMark(c: Client, outcome: "survived" | "died"): void {
    const m = c.mark;
    if (!m) return;
    c.mark = null;
    if (outcome !== "survived") return;
    const me = c.sid ? this.liveSnake(c.sid) : null;
    if (!me) return;
    me.mass += m.reward;
    if (c.life) c.life.marks++;
    this.grantXp(c, XP_MARK, "contracts");
    this.notice(c, NOTICE_MARK_SURVIVED, `you shook off ${m.hunterName} · +${m.reward}`);
    this.events.log("feature", { key: c.key, s: "mark_survived", n: m.reward });
  }

  /** The hunter is gone (dead, or left): everyone it marked has outlived the mark. */
  private settleMarksBy(hunterSid: string): void {
    for (const o of this.clients)
      if (o.mark?.hunterSid === hunterSid) this.settleMark(o, "survived");
  }

  /**
   * A live snake crossing a league length is told so at once, and its ring
   * changes for everyone: every client forgets the snake so the next
   * snapshot resends its full entry with the new league byte.
   */
  private checkPromotions(): void {
    for (const c of this.clients) {
      if (!c.sid || !c.life) continue;
      const s = this.liveSnake(c.sid);
      if (!s) continue;
      const tier = leagueOf(s.mass, this.cutoffs);
      if (tier <= c.life.tier) continue;
      c.life.tier = tier;
      s.league = tier + 1;
      for (const o of this.clients) o.refresh.add(s.id);
      const name = LEAGUES[tier]!.name;
      const runs = Math.min(LEAGUE_BANK_RUNS, (c.profile?.weekRuns[tier] ?? 0) + 1);
      this.notice(
        c,
        NOTICE_PROMOTED,
        `reached ${name} · finish this life to count it (${runs}/${LEAGUE_BANK_RUNS} to bank ${name})`,
      );
      // Gold and up is news for the whole arena; Silver stays private.
      if (tier >= 2)
        for (const o of this.clients) if (o !== c) this.notice(o, 0, `${s.name} reached ${name}`);
      this.events.log("promoted", { key: c.key, s: name, n: Math.floor(s.mass) });
    }
  }

  private trackLives(): void {
    for (const c of this.clients) {
      if (!c.sid || !c.life) continue;
      const s = this.bySid.get(c.sid);
      if (!s) continue;
      if (s.boosting) c.life.boosted = true;
      if (!c.life.boosted && s.mass > c.life.noboostLength) c.life.noboostLength = s.mass;
      // Growth XP follows the peak, so shedding costs nothing and the
      // increments sum to the closed form whatever path the length took.
      if (s.mass > c.life.peak) c.life.peak = s.mass;
      const due = growthXp(c.life.peak - c.life.startMass);
      if (due > c.life.xpGrowth) {
        this.grantXp(c, due - c.life.xpGrowth, "growth");
        c.life.xpGrowth = due;
      }
    }
  }

  /**
   * Book experience on a player's profile: the rested pool doubles it, the
   * cap stops it, and a level crossed pays its track and is announced. The
   * life keeps its breakdown for the death card; it is passed explicitly
   * where the life record has already been detached from the client.
   */
  private grantXp(
    c: Client,
    n: number,
    part: Exclude<XpPart, "rested">,
    life: Life | null = c.life,
  ): void {
    const p = c.profile;
    if (!p || !(n > 0)) return;
    const r = this.profiles.addXp(p, n);
    if (life) {
      life.xp[part] += r.gained - r.bonus;
      life.xp.rested += r.bonus;
    }
    if (r.to > r.from) this.onLevelUp(c, r.to);
  }

  /** A level reached: its track pays in scales, the player is told, and the snake's level byte changes for everyone. */
  private onLevelUp(c: Client, level: number): void {
    const p = c.profile;
    if (!p) return;
    const paid = this.profiles.claimTrack(p);
    const pieces: string[] = [];
    for (const piece of itemsForLevel(level))
      if (this.profiles.grantFresh(p, piece.id)) pieces.push(piece.id);
    for (const id of pieces) this.sendLoot(c, id, LOOT_LEVEL, 0);
    if (pieces.length) this.sendWardrobe(c, WARDROBE_OK);
    const extra = pieces.length ? ` · ${pieces.map(pieceName).join(", ")}` : "";
    this.notice(c, NOTICE_LEVEL, `level ${level} · +${paid} scales${extra}`);
    this.events.log("feature", { key: c.key, s: "level", n: level });
    const s = c.sid ? this.bySid.get(c.sid) : undefined;
    if (s) {
      s.level = level;
      for (const o of this.clients) o.refresh.add(s.id);
    }
  }

  private onNears(): void {
    const now = Date.now();
    for (const n of this.world.nears) {
      const c = this.clientBySid(n.id);
      if (!c || !c.life) continue;
      c.combo = { n: now - c.combo.last < NEAR_COMBO_WINDOW * 1000 ? c.combo.n + 1 : 1, last: now };
      c.life.near++;
      const s = this.liveSnake(n.id);
      const bonus = 1 + Math.min(c.combo.n, 6) * 0.5;
      if (s) s.mass += bonus;
      if (c.v2)
        c.ws.send(
          new Writer()
            .u8(S2C.NEAR)
            .u8(Math.min(255, c.combo.n))
            .u16(Math.round(bonus * 10))
            .finish(),
        );
    }
  }

  private swarmIndex = Math.floor(Math.random() * LANDMARKS.length);

  private startSwarm(): void {
    // Events rotate through the landmarks so players learn where to go.
    const lm = LANDMARKS[this.swarmIndex++ % LANDMARKS.length]!;
    const at = this.world.safeSpawnNear({ x: lm.x, y: lm.y });
    this.world.spawnGoldSwarm(at.x, at.y);
    this.event = { x: at.x, y: at.y, until: Date.now() + SWARM_DURATION_S * 1000 };
    for (const c of this.clients) this.sendEvent(c);
  }

  /** Refresh which snakes carry a bounty; tell newly marked players. */
  private refreshBounties(alive: Snake[]): void {
    const next = new Map<string, number>();
    for (const s of alive.slice(0, 3)) {
      if (s.mass >= BOUNTY_MIN_MASS) next.set(s.id, Math.floor(s.mass * BOUNTY_RATE));
    }
    this.bountyOf = next;
    for (const c of this.clients) {
      if (!c.sid) continue;
      const has = next.has(c.sid);
      if (has && !c.bountied) this.notice(c, 1, `a bounty of ${next.get(c.sid)} is on your head`);
      c.bountied = has;
    }
  }

  private onDeaths(): void {
    for (const d of this.world.deaths) {
      try {
        this.onDeath(d);
      } catch (err) {
        // One death's bookkeeping must not silence the rest of the batch.
        console.error("[death] booking failed:", (err as Error)?.stack ?? err);
      }
    }
    // Wire ids are freed once the whole batch is told: in a head-on both
    // snakes die at once, and each death names the other as its killer.
    // Freeing an id inside the loop minted a fresh one for a snake already
    // dead, which nothing ever released.
    for (const d of this.world.deaths) this.nids.delete(d.snake.id);
  }

  private onDeath(d: DeathEvent): void {
    {
      const s = d.snake;
      const nid = this.nidOf(s.id);
      const killerNid = d.killerId ? this.nidOf(d.killerId) : 0;
      // A player's tokens die with it. A snake dropped after its socket left
      // (no killer, no wall) is the case the token exists for: a reconnect
      // still rebuilds it.
      if (!s.isBot && (d.reason === "wall" || d.killerId))
        this.deadSids.set(s.id, Date.now() + TOKEN_TTL_MS);
      const msg = new Writer()
        .u8(S2C.DEATH)
        .u16(nid)
        .u16(killerNid)
        .u8(d.reason === "wall" ? 0 : 1)
        .str(d.killerName ?? "")
        .str(s.name)
        .u32(Math.floor(s.mass))
        .u16(s.kills)
        .f32(s.x)
        .f32(s.y)
        .finish();
      const bounty = this.bountyOf.get(s.id) ?? 0;
      const killerClient = d.killerId ? this.ownerOf(d.killerId) : null;
      const owner = this.ownerOf(s.id);
      const life = owner?.life ?? null;
      // A death between two players goes in both ledgers; taking down the
      // one the game holds against you is payback.
      const victimP = owner?.profile ?? null;
      const killerP = killerClient?.profile ?? null;
      if (d.killerId?.startsWith("p") && victimP && killerP && victimP.key !== killerP.key) {
        const payback = this.profiles.nemesisOf(killerP)?.key === victimP.key;
        this.profiles.recordRival(victimP, killerP.key, d.killerName ?? "", "killedBy");
        this.profiles.recordRival(killerP, victimP.key, s.name, "killed");
        if (payback && killerClient) {
          const r = killerP.rivals.find((x) => x.key === victimP.key);
          this.notice(
            killerClient,
            NOTICE_PAYBACK,
            `payback · ${s.name} · ${r?.d ?? 1}-${r?.k ?? 0}`,
          );
          if (this.profiles.award(killerP, "payback")) this.achieve(killerClient, "payback");
          this.events.log("feature", { key: killerClient.key, s: "payback" });
        }
      }
      // A kill pays by the victim's length, capped, whoever the victim was.
      if (d.reason === "snake" && killerClient) this.grantXp(killerClient, killXp(s.mass), "kills");
      // Contracts on the dead snake: the hunter who did it inside the clock
      // is paid; any other hunt on it is void.
      const now = Date.now();
      for (const c of this.clients) {
        if (c.hunt?.targetSid !== s.id) continue;
        const filled = Boolean(d.killerId) && c.sid === d.killerId && now <= c.hunt.until;
        this.endHunt(c, filled ? "done" : "void");
      }
      for (const c of this.clients) {
        if (c.known.has(s.id) || c.sid === s.id || (d.killerId && c.sid === d.killerId))
          c.ws.send(msg);
        c.known.delete(s.id);
        c.refresh.delete(s.id);
        if (c.sid === s.id) this.endLife(c, s, true, killerNid);
      }
      // A snake whose socket left dies in its grace window: the life still
      // counts (best, kills, quests, league runs), without a wisp or comeback.
      const left = this.detached.get(s.id);
      if (left) {
        this.detached.delete(s.id);
        this.endLife(left, s, false, killerNid);
      }
      if (!s.isBot) {
        // Cause: the rim, another player, a bot (the boss counts as one), or
        // nobody at all, which is a snake dropped after its socket left.
        const cause =
          d.reason === "wall"
            ? "wall"
            : !d.killerId
              ? "left"
              : d.killerId.startsWith("p")
                ? "player"
                : "bot";
        this.events.log("death", {
          key: owner?.key ?? "",
          s: cause,
          n: Math.floor(s.mass),
          meta: life
            ? {
                survive: Math.round((Date.now() - life.startAt) / 1000),
                kills: s.kills,
                near: life.near,
                boosted: life.boosted,
              }
            : { kills: s.kills },
        });
      }
      // A snake killed after its socket went away has no client to end its
      // life, so the per-snake sets are cleared here as well.
      this.world.nearIds.delete(s.id);
      if (bounty && d.killerId) {
        const killer = this.world.snakes.find((x) => x.id === d.killerId && x.alive);
        if (killer) killer.mass += Math.min(600, Math.floor(bounty * 0.3));
        if (killerClient?.life) killerClient.life.bounty++;
        const line = `${d.killerName ?? "someone"} claimed the ${bounty} bounty on ${s.name}`;
        for (const c of this.clients) this.notice(c, 1, line);
      }
      if (!s.isBot) this.daily.record(s.name, Math.floor(s.mass));
      // Only a real snake-on-snake death marks the spot; a dropped connection
      // or a retired bot has no killer and says nothing about the place.
      if (d.reason === "snake" && d.killerId) this.recordDeath(s.x, s.y);
      this.world.inputs.delete(s.id);
      const g = this.grace.get(s.id);
      if (g) {
        clearTimeout(g);
        this.grace.delete(s.id);
      }
    }
  }

  /**
   * Close out a player's life: profile, challenges, and (after a real death)
   * the afterlife wisp and comeback window. A life ended by the player's own
   * respawn request is booked without either.
   */
  private endLife(c: Client, s: Snake, afterlife = true, killerNid = 0): void {
    c.sid = null;
    // Dying mid-contract is a missed contract; dying while marked ends the
    // mark unpaid; whoever this snake was hunting has outlived it.
    if (c.hunt) {
      c.hunt = null;
      c.huntEndedAt = Date.now();
      c.huntStreak = 0;
    }
    c.mark = null;
    this.settleMarksBy(s.id);
    this.world.nearIds.delete(s.id);
    if (c.party) this.leaveParty(c.party, s.id);
    c.deathAt = Date.now();
    c.deathMass = s.mass;
    c.killerNid = killerNid;
    const life = c.life;
    c.life = null;
    if (!life) return;
    c.rough = Date.now() - life.startAt < 20_000 ? c.rough + 1 : 0;
    if (afterlife) {
      // Afterlife: a wisp for a while, banking starting length for the next life.
      if (c.proto >= 2) {
        c.wisp = {
          x: s.x,
          y: s.y,
          angle: s.angle,
          boost: false,
          until: Date.now() + WISP_SECS * 1000,
          bank: 0,
        };
        this.sendWisp(c, WISP_SECS);
      }
      if (c.v2 && !c.comebackUsed) this.notice(c, 3, "comeback");
    }
    if (!c.profile) return;
    const stats: LifeStats = {
      length: Math.floor(s.mass),
      kills: s.kills,
      survive: (Date.now() - life.startAt) / 1000,
      near: life.near,
      remains: Math.floor(life.remains),
      noboostLength: Math.floor(life.noboostLength),
      bounty: life.bounty,
      contracts: life.contracts,
      marks: life.marks,
    };
    const bestBefore = c.profile.best;
    const { completed, milestones, freezeEarned, chest, banked, firstToday } =
      this.profiles.recordLife(c.profile, stats, { x: s.x, y: s.y }, this.cutoffs);
    if (stats.length > bestBefore)
      this.events.log("feature", { key: c.key, s: "best", n: stats.length });
    if (banked) {
      const name = LEAGUES[banked - 1]!.name;
      this.notice(c, 2, `${name} banked for the week: ${rewardText(banked)} when it rolls`);
      const feat = this.profiles.bankFeat(c.profile, banked);
      if (feat) this.achieve(c, feat);
      this.events.log("banked", { key: c.key, s: name, n: stats.length });
    }
    for (const ch of completed) {
      this.notice(c, 2, `quest step done: ${ch.text}`);
      this.grantXp(c, XP_QUEST, "other", life);
    }
    if (chest) {
      this.notice(c, 2, this.profiles.openChest(c.profile));
      this.events.log("feature", { key: c.key, s: "chest" });
      this.grantXp(c, XP_CHEST, "other", life);
    }
    if (firstToday) this.grantXp(c, XP_DAILY, "other", life);
    const scales = lifeScales(stats) + completed.length * SCALES_QUEST + (chest ? SCALES_CHEST : 0);
    this.profiles.addScales(c.profile, scales);
    life.scales += scales;
    for (const m of milestones) this.notice(c, 2, `streak milestone: ${m} unlocked`);
    if (freezeEarned)
      this.notice(c, 0, "streak freeze banked: one missed day will not break your streak");
    const earned = this.profiles.awardTotals(c.profile);
    for (const id of lifeFeats(stats)) if (this.profiles.award(c.profile, id)) earned.push(id);
    for (const id of earned) this.achieve(c, id, life);
    // The life's experience, summed for the death card: every part it came
    // from, the rested bonus, and the scales it paid.
    const x = life.xp;
    const total = x.growth + x.kills + x.contracts + x.boss + x.other + x.rested;
    if (total > 0 || life.scales > 0) {
      const parts: string[] = [];
      if (x.growth) parts.push(`growth ${x.growth}`);
      if (x.kills) parts.push(`kills ${x.kills}`);
      if (x.contracts) parts.push(`contracts ${x.contracts}`);
      if (x.boss) parts.push(`boss ${x.boss}`);
      if (x.other) parts.push(`bonus ${x.other}`);
      if (x.rested) parts.push(`rested +${x.rested}`);
      parts.push(`${life.scales} scales`);
      this.notice(c, NOTICE_XP, `+${total} XP · ${parts.join(" · ")}`);
    }
    void this.sendProfile(c);
  }

  private onEats(): void {
    const bySid = new Map<string, Writer>();
    const counts = new Map<string, number>();
    for (const e of this.world.eats) {
      if (e.k === 2) {
        const c = this.clientBySid(e.id);
        if (c?.life) c.life.remains += e.v;
      }
      let w = bySid.get(e.id);
      if (!w) {
        w = new Writer().u8(S2C.EAT).u16(0);
        bySid.set(e.id, w);
        counts.set(e.id, 0);
      }
      const n = counts.get(e.id)!;
      if (n >= 48) continue;
      w.f32(e.x)
        .f32(e.y)
        .u16(Math.round(e.v * 10))
        .u8(e.c);
      counts.set(e.id, n + 1);
    }
    for (const c of this.clients) {
      if (!c.sid) continue;
      const w = bySid.get(c.sid);
      if (!w) continue;
      const bytes = w.finish();
      new DataView(bytes.buffer, bytes.byteOffset).setUint16(1, counts.get(c.sid)!);
      c.ws.send(bytes);
    }
  }

  private inView(v: View, x: number, y: number, pad: number): boolean {
    return Math.abs(x - v.cx) <= v.hw + pad && Math.abs(y - v.cy) <= v.hh + pad;
  }

  private snakeVisible(c: Client, s: Snake): boolean {
    if (s.id === c.sid) return true;
    // Geometry from the step's cache: this runs per snake, per client, per snapshot.
    const box = s.box;
    const r = box ? box.r : radiusOf(s.mass);
    if (this.inView(c.view, s.x, s.y, VIEW_MARGIN + r)) return true;
    // A long body can be on screen while the head is far away.
    if (box) {
      const v = c.view;
      const pad = VIEW_MARGIN + r;
      if (
        box.maxX < v.cx - v.hw - pad ||
        box.minX > v.cx + v.hw + pad ||
        box.maxY < v.cy - v.hh - pad ||
        box.minY > v.cy + v.hh + pad
      )
        return false;
    } else if (!this.inView(c.view, s.x, s.y, VIEW_MARGIN + lengthOf(s.mass) + r)) return false;
    const pts = s.points;
    const stride = Math.max(1, (pts.length / 12) | 0);
    for (let i = 0; i < pts.length; i += stride) {
      const p = pts[i]!;
      if (this.inView(c.view, p.x, p.y, VIEW_MARGIN + r)) return true;
    }
    return false;
  }

  private sendSnapshot(c: Client): void {
    if (c.wisp) this.sendWisp(c, (c.wisp.until - Date.now()) / 1000);
    if (c.seq) c.ws.send(this.outAdd.reset().u8(S2C.ACK).u16(c.seq).finish());
    const w = this.outSnap
      .reset()
      .u8(S2C.SNAP)
      .u32(this.tick)
      .u32(Date.now() >>> 0);
    // Snakes near the centre of the view update every snapshot; those out in
    // the margin update every other one, which halves traffic on a zoomed-out
    // screen full of bodies. The client's interpolation tolerates the gap.
    const half = this.tick % 2 === 0;
    const shrink = -Math.max(c.view.hw, c.view.hh) * 0.2;
    const visible: Snake[] = [];
    const seen = new Set<string>();
    for (const s of this.world.snakes) {
      if (!s.alive || !this.snakeVisible(c, s)) continue;
      seen.add(s.id);
      const far = s.id !== c.sid && !this.inView(c.view, s.x, s.y, shrink);
      if (far && !half && c.known.has(s.id)) continue;
      visible.push(s);
    }
    w.u16(visible.length);
    for (const s of visible) {
      const full = !c.known.has(s.id) || c.refresh.delete(s.id);
      writeSnakeEntry(w, this.nidOf(s.id), s, full, MAX_NET_POINTS, packSkin(s.skin, s.trail ?? 0));
      if (full && c.proto >= 2) w.u8(Math.min(255, s.level ?? 0));
      if (full && c.proto >= 3) w.u8(s.league ?? 0).u8(Math.min(255, s.might ?? 0));
      if (full && c.proto >= 4) w.u8(s.finish ?? 0);
      // Protocol 6: the wardrobe, five catalog indexes.
      if (full && c.proto >= 6) for (let k = 0; k < 5; k++) w.u8(s.loadout?.[k] ?? 0);
      c.known.add(s.id);
    }
    const gone: number[] = [];
    for (const sid of c.known) {
      if (!seen.has(sid)) {
        gone.push(this.nidOf(sid));
        c.known.delete(sid);
        c.refresh.delete(sid);
      }
    }
    w.u16(gone.length);
    for (const nid of gone) w.u16(nid);
    const chase = this.world.chaseOrbs;
    w.u8(chase.length);
    for (const f of chase)
      w.u32(f.id ?? 0)
        .f32(f.x)
        .f32(f.y);
    c.ws.send(w.finish());
  }

  /**
   * Bring the client's orbs in line with the server's for the area on
   * screen. Cells are stamped by the world on every change and logged, so a
   * sync walks only the cells that entered the view since the last one and
   * the cells the world changed since then; a still view with nothing
   * happening in it costs nothing, and a full arena's syncs no longer scale
   * with how much screen each client has. Cells that left the view are
   * dropped. An orb that crossed between two cells in view stays put on the
   * client (its position there is cosmetic). The first sync, and any sync
   * after one the add cap cut short, walks the whole view.
   */
  private sendFood(c: Client): void {
    const v = c.view;
    const pad = VIEW_MARGIN + CELL;
    const gx0 = Math.floor((v.cx - v.hw - pad) / CELL);
    const gx1 = Math.floor((v.cx + v.hw + pad) / CELL);
    const gy0 = Math.floor((v.cy - v.hh - pad) / CELL);
    const gy1 = Math.floor((v.cy + v.hh + pad) / CELL);
    const inRange = (gx: number, gy: number): boolean =>
      gx >= gx0 && gx <= gx1 && gy >= gy0 && gy <= gy1;
    const world = this.world;
    const add = this.outAdd.reset().u8(S2C.FOOD_ADD).u16(0);
    const del = this.outDel.reset().u8(S2C.FOOD_DEL).u16(0);
    let nAdd = 0;
    let nDel = 0;
    const drop = (id: number): void => {
      if (!c.sentFood.delete(id)) return;
      del.u32(id);
      nDel++;
    };
    const leave = (key: number): void => {
      const cell = c.foodCells.get(key);
      if (!cell) return;
      for (const id of cell.ids) drop(id);
      c.foodCells.delete(key);
    };
    const prev = c.foodRect;
    const changed = prev ? world.foodCellsChangedSince(c.foodSeq) : null;
    const full = !prev || !changed;
    const seqNow = world.foodSeqNow;
    // Cells that left the view: everything the client holds there goes.
    if (full) {
      for (const [key, cell] of c.foodCells) if (!inRange(cell.gx, cell.gy)) leave(key);
    } else {
      for (let gx = prev.gx0; gx <= prev.gx1; gx++) {
        if (gx < gx0 || gx > gx1) {
          for (let gy = prev.gy0; gy <= prev.gy1; gy++) leave(cellKeyOf(gx, gy));
          continue;
        }
        for (let gy = prev.gy0; gy < gy0 && gy <= prev.gy1; gy++) leave(cellKeyOf(gx, gy));
        for (let gy = Math.max(prev.gy0, gy1 + 1); gy <= prev.gy1; gy++) leave(cellKeyOf(gx, gy));
      }
    }
    let capped = false;
    const walk = (gx: number, gy: number): void => {
      const key = cellKeyOf(gx, gy);
      const stamp = world.foodCellStamp(key);
      let cell = c.foodCells.get(key);
      if (cell && cell.stamp === stamp) return;
      if (!cell) {
        cell = { gx, gy, stamp: -1, ids: [] };
        c.foodCells.set(key, cell);
      }
      // Orbs the client holds for this cell that are no longer in it: gone
      // from the world, moved out of view, or moved to another cell in view
      // (that cell's stamp changed too, so it adopts the id below).
      if (cell.ids.length) {
        let keep = 0;
        for (const id of cell.ids) {
          const f = world.foodById.get(id);
          if (f && cellKey(f.x, f.y) === key) {
            cell.ids[keep++] = id;
            continue;
          }
          if (!f || !inRange(Math.floor(f.x / CELL), Math.floor(f.y / CELL))) drop(id);
        }
        cell.ids.length = keep;
      }
      const bucket = world.foodsInCell(key);
      if (bucket) {
        for (const f of bucket) {
          const id = f.id!;
          if (cell.ids.includes(id)) continue;
          if (c.sentFood.has(id)) {
            cell.ids.push(id);
            continue;
          }
          if (nAdd >= FOOD_ADD_CAP) {
            capped = true;
            continue;
          }
          cell.ids.push(id);
          c.sentFood.add(id);
          writeFood(add, f);
          nAdd++;
        }
      }
      // A cell cut short by the cap keeps its old stamp and is walked again next time.
      if (!capped) cell.stamp = stamp;
    };
    if (full) {
      for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) walk(gx, gy);
    } else {
      // Cells new to the view, in full.
      for (let gx = gx0; gx <= gx1; gx++) {
        if (gx < prev.gx0 || gx > prev.gx1) {
          for (let gy = gy0; gy <= gy1; gy++) walk(gx, gy);
          continue;
        }
        for (let gy = gy0; gy < prev.gy0 && gy <= gy1; gy++) walk(gx, gy);
        for (let gy = Math.max(gy0, prev.gy1 + 1); gy <= gy1; gy++) walk(gx, gy);
      }
      // Cells the world changed since the last sync, inside the part of the view kept.
      for (const key of changed) {
        const { gx, gy } = cellCoordsOf(key);
        if (!inRange(gx, gy)) continue;
        if (gx < prev.gx0 || gx > prev.gx1 || gy < prev.gy0 || gy > prev.gy1) continue;
        walk(gx, gy);
      }
    }
    if (capped) {
      c.foodRect = null;
    } else {
      c.foodRect = { gx0, gx1, gy0, gy1 };
      c.foodSeq = seqNow;
    }
    if (nAdd) {
      const bytes = add.finish();
      new DataView(bytes.buffer, bytes.byteOffset).setUint16(1, nAdd);
      c.ws.send(bytes);
    }
    if (nDel) {
      const bytes = del.finish();
      new DataView(bytes.buffer, bytes.byteOffset).setUint16(1, nDel);
      c.ws.send(bytes);
    }
  }

  /** The wire id of a profile's nemesis while their snake is alive here, else 0. */
  private nemesisNid(p: Profile): number {
    const nem = this.profiles.nemesisOf(p);
    if (!nem) return 0;
    for (const o of this.clients) {
      if (!o.sid || o.profile?.key !== nem.key) continue;
      if (this.world.snakes.some((s) => s.id === o.sid && s.alive)) return this.nidOf(o.sid);
    }
    return 0;
  }

  /** The ranking and boards are computed once, then each client gets its own line. */
  private sendStatsAll(): void {
    if (!this.clients.size) return;
    const now = Date.now();
    const alive = this.world.snakes.filter((s) => s.alive).sort((a, b) => b.mass - a.mass);
    this.refreshBounties(alive);
    const rankOf = new Map<string, number>();
    alive.forEach((s, i) => rankOf.set(s.id, i + 1));
    const top = alive.slice(0, 10);
    const daily = this.daily.top(10);
    const encodeBoard = (v2: boolean, v3: boolean, v5: boolean) => {
      const board = new Writer();
      board.u8(top.length);
      for (const s of top) {
        board.u16(this.nidOf(s.id)).str(s.name).u32(Math.floor(s.mass)).f32(s.x).f32(s.y);
        if (v2) board.u32(this.bountyOf.get(s.id) ?? 0);
        if (v3) board.u8(s.league ?? 0);
        // The player list draws level, crown and badge per row.
        if (v5) board.u8(Math.min(255, s.level ?? 0)).u8((s.crown ? 1 : 0) | (s.linked ? 2 : 0));
      }
      board.u8(daily.length);
      for (const e of daily) board.str(e.name).u32(e.best);
      return board.finish();
    };
    const tail1 = encodeBoard(false, false, false);
    const tail2 = encodeBoard(true, false, false);
    const tail3 = encodeBoard(true, true, false);
    const tail5 = encodeBoard(true, true, true);
    for (const c of this.clients) {
      const me = c.sid ? alive.find((s) => s.id === c.sid) : undefined;
      const tail = c.v2 ? (c.proto >= 5 ? tail5 : c.proto >= 3 ? tail3 : tail2) : tail1;
      const w = new Writer()
        .u8(c.v2 ? S2C.STATS2 : S2C.STATS)
        .f32(me?.mass ?? 0)
        .u16(me ? (rankOf.get(me.id) ?? 0) : 0)
        .u16(alive.length)
        .u16(me?.kills ?? 0)
        .u16(this.clients.size);
      w.raw(tail);
      if (c.v2) {
        // Party members' names and lengths, then the arena mode clock.
        const mates: Snake[] = [];
        if (c.party) {
          for (const sid of this.parties.get(c.party) ?? []) {
            if (sid === c.sid) continue;
            const m = this.world.snakes.find((x) => x.id === sid && x.alive);
            if (m) mates.push(m);
          }
        }
        w.u8(Math.min(8, mates.length));
        for (const m of mates.slice(0, 8)) w.str(m.name).u32(Math.floor(m.mass));
        const mode = modeNow();
        w.u8(mode.id).u16(Math.min(65535, mode.secsLeft)).u16(Math.min(65535, mode.secsToNext));
        const b = this.boss && this.boss.alive ? this.boss : null;
        w.u8(b ? Math.round((100 * (b.hp ?? 0)) / (b.hpMax ?? 1)) : 255)
          .f32(b?.x ?? 0)
          .f32(b?.y ?? 0);
        // The nemesis's live snake, so the client can mark it and say they are here.
        w.u16(c.profile ? this.nemesisNid(c.profile) : 0);
        // The contract on offer: the target (wire id, clock, reward, where it
        // is, its name), the streak, and the mark on this player.
        const h = c.hunt;
        const t = h ? this.liveSnake(h.targetSid) : null;
        w.u16(t ? (this.nids.get(t.id) ?? 0) : 0)
          .u16(h ? Math.max(0, Math.min(65535, Math.ceil((h.until - now) / 1000))) : 0)
          .u16(h ? Math.min(65535, h.reward) : 0)
          .f32(t?.x ?? 0)
          .f32(t?.y ?? 0)
          .str(t ? h!.targetName : "")
          .u8(Math.min(255, c.huntStreak));
        const m = c.mark;
        w.u16(m ? (this.nids.get(m.hunterSid) ?? 0) : 0)
          .u16(m ? Math.max(0, Math.min(65535, Math.ceil((m.until - now) / 1000))) : 0)
          .u16(m ? Math.min(65535, m.reward) : 0)
          .str(m?.hunterName ?? "");
        // The season's league ladder, so every client draws the same tiers.
        for (let i = 0; i < LEAGUES.length; i++) w.u32(Math.min(0xffffffff, this.cutoffs[i] ?? 0));
        // Experience and the rested pool, for the bar along the bottom.
        w.u32(c.profile?.xp ?? 0).u32(c.profile?.rested ?? 0);
      }
      c.ws.send(w.finish());
    }
  }
}

/** The LOOT source byte for a catalog piece. */
function lootSourceOf(id: string): number {
  switch (cosmeticById(id)?.source.kind) {
    case "level":
      return LOOT_LEVEL;
    case "shop":
      return LOOT_SHOP;
    case "boss":
      return LOOT_BOSS;
    case "feat":
      return LOOT_FEAT;
    case "season":
      return LOOT_SEASON;
    default:
      return LOOT_DROP;
  }
}

function pieceName(id: string): string {
  return cosmeticById(id)?.name ?? id;
}

export function makeHelloPayload(
  name: string,
  skin: number,
  bands: string[] | undefined,
  token: string,
): Uint8Array {
  const w = new Writer().u8(C2S.HELLO).str(name).u8(skin);
  writeBands(w, bands);
  w.str(token);
  return w.finish();
}

export { START_MASS, checkAgentPass, mintAgentPass };
