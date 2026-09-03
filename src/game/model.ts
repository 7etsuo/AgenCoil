/**
 * Units follow slither.io's client: a fresh snake is 29 units wide, the map
 * radius there is 21600 for hundreds of players, so ours is scaled to the
 * bot count. Speed, turn rate, scale and spacing are slither.io's formulas.
 */
export const ARENA_RADIUS = 7200;
export const FOOD_TARGET = 16000;
export const TICK = 1 / 60;
export const START_MASS = 10;
export const MIN_MASS = 10;
/** You need a little length in the bank before boosting is allowed. */
export const BOOST_MIN_MASS = 11;
/** Boosting sheds a constant length per second, as six pellets per second. */
export const BOOST_DRAIN = 15;
export const BOOST_DROP_EVERY = 1 / 6;
export const SPAWN_INVULN = 1.6;
export const NET_INTERVAL = 1000 / 18;
export const INTERP_DELAY = 110;
export const MAX_NET_POINTS = 56;
export const MAX_BOTS = 24;
export const CHASE_ORBS = 16;
export const MAGNET_SPEED = 420;
export const BOT_RESPAWN_DELAY = 2.5;
export const SERVER_TICK_HZ = 40;
export const SNAPSHOT_HZ = 30;
export const FOOD_SYNC_HZ = 10;
export const DISCONNECT_GRACE_MS = 10_000;
export const MAX_CUSTOM_BANDS = 6;
/** Bots on the authoritative server, where CPU is cheaper than an empty arena. */
export const SERVER_BOTS = 50;
export const MAX_SCALE = 4.86;
/** Near miss: head passes within this multiple of the summed radii, without touching. */
export const NEAR_FACTOR = 1.9;
export const NEAR_COOLDOWN = 1.5;
export const NEAR_COMBO_WINDOW = 3.5;
/** Bounties sit on the top three snakes once they are this long. */
export const BOUNTY_MIN_MASS = 300;
export const BOUNTY_RATE = 0.5;
/** Golden swarm arena events. */
export const SWARM_EVERY_S = 200;
export const SWARM_ORBS = 70;
export const SWARM_DURATION_S = 45;
export const COMEBACK_KEEP = 0.25;
export const COMEBACK_WINDOW_MS = 6000;
export const BASE_WIDTH = 29;

export type Phase = "menu" | "play" | "dead";

export interface Vec {
  x: number;
  y: number;
}

/**
 * One orb. `k` is the kind: 0 natural, 1 boost trail, 2 remains of a dead
 * snake, 3 chase orb (flees from heads, worth the most).
 */
export interface Food {
  x: number;
  y: number;
  v: number;
  c: number;
  r: number;
  k: number;
  /** Server-assigned id; absent in the offline simulation. */
  id?: number;
}

export interface Snake {
  id: string;
  name: string;
  skin: number;
  x: number;
  y: number;
  angle: number;
  mass: number;
  boosting: boolean;
  points: Vec[];
  alive: boolean;
  isBot: boolean;
  invuln: number;
  wander: number;
  think: number;
  avoid: number;
  avoidDir: number;
  boostLeft: number;
  dropped: number;
  /** Custom skin colours (hex), overriding `skin` when present. */
  bands?: string[];
  /** Bot personality 0..1: timid to aggressive. */
  temper: number;
  /** Kills this life. */
  kills: number;
  /** Cosmetics: boost trail and death effect ids (see challenges.ts). */
  trail?: number;
  deathFx?: number;
  /** Last near-miss time per other snake id (server side, not on the wire). */
  nearMark?: Map<string, number>;
}

export interface Camera {
  x: number;
  y: number;
  z: number;
  trauma: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  r: number;
}

export interface Floater {
  x: number;
  y: number;
  text: string;
  life: number;
  color: string;
}

/**
 * A skin is a repeating band pattern. `bands` lists segment colors in order
 * and `band` is how many segments each color runs before the next one.
 * `fill` is the representative color (menu swatch, minimap, remains).
 */
export interface Skin {
  fill: string;
  shine: string;
  bands: string[];
  band: number;
}

export const SKINS: Skin[] = [
  { fill: "#3ee0c4", shine: "#b8fff2", bands: ["#3ee0c4", "#1aae96"], band: 3 },
  {
    fill: "#6ea8ff",
    shine: "#d6e7ff",
    bands: ["#6ea8ff", "#3b74d9", "#6ea8ff", "#f4f7ff"],
    band: 2,
  },
  { fill: "#e45fa0", shine: "#ffd0e7", bands: ["#e45fa0", "#b83278"], band: 4 },
  { fill: "#f0c14a", shine: "#ffe9ad", bands: ["#f0c14a", "#2a2f3a"], band: 2 },
  { fill: "#c45c6a", shine: "#ffc4cc", bands: ["#c45c6a", "#8f3b47", "#ffb3bd"], band: 3 },
  { fill: "#9b8cff", shine: "#ddd6ff", bands: ["#9b8cff", "#6b5ad6"], band: 5 },
  { fill: "#7dcf6a", shine: "#d4f7cb", bands: ["#7dcf6a", "#4ea63b", "#f7f3a6"], band: 2 },
  { fill: "#f28b5c", shine: "#ffd4c0", bands: ["#f28b5c", "#c45f32"], band: 3 },
  { fill: "#5ad0e8", shine: "#c8f4ff", bands: ["#5ad0e8", "#2a9bb3", "#ffffff"], band: 2 },
  { fill: "#e8eaee", shine: "#ffffff", bands: ["#e8eaee", "#9aa3b2"], band: 4 },
  { fill: "#d45dff", shine: "#f0c4ff", bands: ["#d45dff", "#9b32c4", "#3ee0c4"], band: 2 },
  { fill: "#ff6b8a", shine: "#ffc8d4", bands: ["#ff6b8a", "#c43b58"], band: 3 },
  { fill: "#4fd1a5", shine: "#c8ffe8", bands: ["#4fd1a5", "#2a9a78", "#f0c14a"], band: 3 },
  { fill: "#ffb347", shine: "#ffe0a8", bands: ["#ffb347", "#d4891c"], band: 6 },
  {
    fill: "#7aa2ff",
    shine: "#d4e2ff",
    bands: ["#ff6b8a", "#ffb347", "#f7f3a6", "#7dcf6a", "#5ad0e8", "#9b8cff"],
    band: 2,
  },
  { fill: "#c8d0dc", shine: "#f4f6fa", bands: ["#c8d0dc", "#2a2f3a"], band: 1 },
];

export const FOOD_COLORS = [
  "#3ee0c4",
  "#6ea8ff",
  "#e45fa0",
  "#f0c14a",
  "#c45c6a",
  "#9b8cff",
  "#7dcf6a",
  "#f28b5c",
  "#5ad0e8",
  "#e8eaee",
  "#d45dff",
  "#ff6b8a",
];

/** Index into FOOD_COLORS used by chase orbs. */
export const CHASE_COLOR = 3;

export const BOT_NAMES = [
  "onyx",
  "mica",
  "viper",
  "nacre",
  "ember",
  "quartz",
  "lumen",
  "sable",
  "iris",
  "cobalt",
  "ash",
  "neon",
  "drift",
  "helix",
  "rune",
  "vapor",
  "kestrel",
  "sol",
  "nyx",
  "flux",
  "orbit",
  "tide",
  "fable",
  "cinder",
  "moth",
  "pixel",
  "gale",
  "zinc",
  "noodle",
  "snek",
  "danger",
  "worm",
  "mia",
  "leo",
  "ava",
  "kai",
  "zed",
  "big boi",
  "tiny",
  "juju",
  "rex",
  "nova",
  "milo",
  "pip",
  "lucky",
  "ghost",
  "turbo",
  "mango",
];

export function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * slither.io's body scale: 1 at the start, growing with length toward
 * MAX_SCALE. The client derives it from body-part count; we map it from mass
 * so that length 1000 is about 2x, 4000 about 2.9x and 12000 about 4x.
 */
export function scaleOf(mass: number): number {
  return Math.min(MAX_SCALE, 1 + Math.pow(Math.max(0, mass - 10) / 990, 0.45));
}

/** Body half-width: slither.io's `sc * 29` width. */
export function radiusOf(mass: number): number {
  return (BASE_WIDTH / 2) * scaleOf(mass);
}

/** Body parts, slither.io's `sct`: 2 + 106 per unit of scale. */
export function partsOf(mass: number): number {
  return 2 + 106 * (scaleOf(mass) - 1);
}

/** Distance between body parts: slither.io's `wsep = 6 * sc`. */
export function spacingOf(mass: number): number {
  return 6 * scaleOf(mass);
}

/** Body length in world units: parts times spacing, never under ~3 widths. */
export function lengthOf(mass: number): number {
  const sc = scaleOf(mass);
  return Math.max(BASE_WIDTH * sc * 3.2, partsOf(mass) * 6 * sc);
}

/**
 * Head speed in units per second. slither.io moves `sp / 4` units per 8 ms
 * frame with `sp = 5.39 + 0.4 * sc` (14 + 0.4 * sc while boosting).
 */
export function speedOf(mass: number, boosting: boolean): number {
  const sc = scaleOf(mass);
  return ((boosting ? 14 : 5.39) + 0.4 * sc) * 31.25;
}

/**
 * Turn rate in radians per second: slither.io's `mamu` (0.033 rad per 8 ms)
 * times `scang = 0.13 + 0.87 * ((7 - sc) / 6)^2`. The turning circle stays
 * between one and two body widths at every size.
 */
export function turnRateOf(mass: number): number {
  const sc = scaleOf(mass);
  const scang = 0.13 + 0.87 * Math.pow((7 - sc) / 6, 2);
  return 4.125 * scang;
}

/** Camera zoom: 0.9 for a fresh snake, easing out to about half at max scale. */
export function zoomOf(mass: number): number {
  return clamp(0.9 - (scaleOf(mass) - 1) * 0.11, 0.48, 0.9);
}

export function maxPointsOf(mass: number): number {
  return Math.max(12, Math.round(lengthOf(mass) / spacingOf(mass)) + 6);
}

/** Mass lost per second while boosting: constant, like slither.io. */
export function boostDrainOf(_mass: number): number {
  return BOOST_DRAIN;
}

/**
 * The wire's skin byte carries the skin index in the low nibble and the
 * trail id in the high nibble, so older clients (which take skin % 16) keep
 * working while newer ones read the cosmetic.
 */
export function packSkin(skin: number, trail: number): number {
  return (skin & 15) | ((trail & 15) << 4);
}
export function unpackSkin(byte: number): { skin: number; trail: number } {
  return { skin: byte & 15, trail: (byte >> 4) & 15 };
}

/** Resolve the colour bands a snake is drawn with. */
export function bandsOf(s: { skin: number; bands?: string[] }): string[] {
  if (s.bands && s.bands.length) return s.bands;
  return SKINS[s.skin % SKINS.length]!.bands;
}

/** Representative colour for labels, minimap dots and remains. */
export function fillOf(s: { skin: number; bands?: string[] }): string {
  if (s.bands && s.bands.length) return s.bands[0]!;
  return SKINS[s.skin % SKINS.length]!.fill;
}

export function randRange(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

export function randomInDisk(r: number): Vec {
  const t = Math.random() * Math.PI * 2;
  const d = Math.sqrt(Math.random()) * r;
  return { x: Math.cos(t) * d, y: Math.sin(t) * d };
}

export function pickBotName(used: Set<string>): string {
  const pool = BOT_NAMES.filter((n) => !used.has(n.toLowerCase()));
  return pool.length
    ? pool[(Math.random() * pool.length) | 0]!
    : `${BOT_NAMES[(Math.random() * BOT_NAMES.length) | 0]}${(Math.random() * 99) | 0}`;
}

export function pointSegDist2(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = 0;
  if (l2 > 1e-8) t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  const x = ax + dx * t;
  const y = ay + dy * t;
  return dist2(px, py, x, y);
}
