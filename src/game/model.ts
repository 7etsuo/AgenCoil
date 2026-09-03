export const ARENA_RADIUS = 3800;
export const FOOD_TARGET = 640;
export const TICK = 1 / 60;
export const BASE_SPEED = 172;
export const BOOST_SPEED = 348;
export const START_MASS = 22;
export const MIN_MASS = 12;
export const BOOST_DRAIN = 3.6;
export const BOOST_DROP_EVERY = 0.09;
export const SPAWN_INVULN = 1.7;
export const NET_INTERVAL = 1000 / 18;
export const INTERP_DELAY = 110;
export const MAX_NET_POINTS = 56;
export const MAX_BOTS = 14;

export type Phase = "menu" | "play" | "dead";

export interface Vec {
  x: number;
  y: number;
}

export interface Food {
  x: number;
  y: number;
  v: number;
  c: number;
  r: number;
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

export interface Skin {
  fill: string;
  alt: string;
  shine: string;
}

export const SKINS: Skin[] = [
  { fill: "#3ee0c4", alt: "#1aae96", shine: "#b8fff2" },
  { fill: "#6ea8ff", alt: "#3b74d9", shine: "#d6e7ff" },
  { fill: "#e45fa0", alt: "#b83278", shine: "#ffd0e7" },
  { fill: "#f0c14a", alt: "#c99218", shine: "#ffe9ad" },
  { fill: "#c45c6a", alt: "#8f3b47", shine: "#ffc4cc" },
  { fill: "#9b8cff", alt: "#6b5ad6", shine: "#ddd6ff" },
  { fill: "#7dcf6a", alt: "#4ea63b", shine: "#d4f7cb" },
  { fill: "#f28b5c", alt: "#c45f32", shine: "#ffd4c0" },
  { fill: "#5ad0e8", alt: "#2a9bb3", shine: "#c8f4ff" },
  { fill: "#e8eaee", alt: "#9aa3b2", shine: "#ffffff" },
  { fill: "#d45dff", alt: "#9b32c4", shine: "#f0c4ff" },
  { fill: "#ff6b8a", alt: "#c43b58", shine: "#ffc8d4" },
  { fill: "#4fd1a5", alt: "#2a9a78", shine: "#c8ffe8" },
  { fill: "#ffb347", alt: "#d4891c", shine: "#ffe0a8" },
  { fill: "#7aa2ff", alt: "#4a70d0", shine: "#d4e2ff" },
  { fill: "#c8d0dc", alt: "#7a8494", shine: "#f4f6fa" },
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

export function radiusOf(mass: number): number {
  return 7.2 + Math.pow(Math.max(mass, 1), 0.46) * 1.48;
}

export function lengthOf(mass: number): number {
  return 78 + mass * 3.05;
}

export function turnRateOf(mass: number): number {
  const r = radiusOf(mass);
  return 5.4 * (14 / (14 + r));
}

export function zoomOf(mass: number): number {
  const r = radiusOf(mass);
  return clamp(0.78 / (0.7 + r / 42 + mass / 1300), 0.2, 1.05);
}

export function spacingOf(mass: number): number {
  return Math.max(5.8, radiusOf(mass) * 0.52);
}

export function maxPointsOf(mass: number): number {
  return Math.max(12, Math.round(lengthOf(mass) / spacingOf(mass)) + 6);
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
  return pool.length ? pool[(Math.random() * pool.length) | 0]! : `bot-${(Math.random() * 99) | 0}`;
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
