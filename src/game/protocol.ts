/**
 * Binary wire protocol between the game server and clients. Both sides import
 * this file, so the layout lives in one place. Every message starts with a
 * one-byte type tag.
 */
import { MAX_CUSTOM_BANDS, wrapAngle, type Food, type Snake, type Vec } from "./model";

export const C2S = {
  HELLO: 1,
  INPUT: 2,
  SPAWN: 3,
  PING: 4,
  /** Device key and name, sent on connect so the menu can show the profile. */
  IDENT: 5,
  /** A quick reaction (0..3) shown above the snake. */
  EMOTE: 6,
  CREW: 7,
  /** Choose the handle a linked player is named by. */
  HANDLE: 8,
  /** The wardrobe: equip, unequip or buy a piece (op u8, slot u8, id str). */
  WARDROBE: 9,
} as const;

export const S2C = {
  WELCOME: 1,
  SNAP: 2,
  FOOD_ADD: 3,
  FOOD_DEL: 4,
  STATS: 5,
  EAT: 6,
  DEATH: 7,
  TOKEN: 8,
  PONG: 9,
  SPAWNED: 10,
  /** Sequence of the last input applied; only sent to clients that number inputs. */
  ACK: 11,
  /** Persistent profile: best, kills, games, longest survival, rank, unlocks. */
  PROFILE: 12,
  /** Today's three challenges with progress. */
  CHALLENGES: 13,
  /** A near miss by this client's snake, with the current combo. */
  NEAR: 14,
  /** Arena event: a golden swarm at a position, for a duration. */
  EVENT: 15,
  /** A short notice line (bounty claimed, challenge done, bounty on you). */
  NOTICE: 16,
  /** Leaderboard v2: board entries carry a bounty. Sent instead of STATS to v2 clients. */
  STATS2: 17,
  /** The server refused a spawn because no valid human-verification session exists. */
  GATE_REQUIRED: 18,
  /** This instance is full; the client should reconnect after the given seconds. */
  FULL: 19,
  /** Someone emoted: nid, emote id. */
  EMOTE: 20,
  /** Afterlife wisp position, bank and seconds left (0 ends it). */
  WISP: 21,
  /** An achievement this client just earned: id. */
  ACHIEVE: 22,
  /** Answer to a handle request: a status (HANDLE_*) and the handle now held. */
  HANDLE: 23,
  /** The wardrobe: a status (WARDROBE_*), the five equipped ids, then the owned ids (u16 count). */
  WARDROBE: 24,
  /** A piece arriving: id, rarity, source, and the scales paid instead when already owned. */
  LOOT: 25,
} as const;

export const HANDLE_OK = 0;
export const HANDLE_INVALID = 1;
export const HANDLE_TAKEN = 2;
export const HANDLE_NOT_LINKED = 3;
export const HANDLE_TOO_SOON = 4;
export const HANDLE_UNAVAILABLE = 5;

export const WARDROBE_OK = 0;
export const WARDROBE_NOT_OWNED = 1;
export const WARDROBE_WRONG_SLOT = 2;
export const WARDROBE_NOT_FOR_SALE = 3;
export const WARDROBE_TOO_POOR = 4;
export const WARDROBE_UNKNOWN = 5;
export const WARDROBE_TOO_SOON = 6;
export const WARDROBE_OWNED = 7;
/** Where a piece came from, on LOOT. */
export const LOOT_LEVEL = 0;
export const LOOT_SHOP = 1;
export const LOOT_BOSS = 2;
export const LOOT_DROP = 3;
export const LOOT_FEAT = 4;
export const LOOT_SEASON = 5;

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Writer {
  private buf = new ArrayBuffer(1024);
  private view = new DataView(this.buf);
  private bytes = new Uint8Array(this.buf);
  private pos = 0;

  private need(n: number): void {
    if (this.pos + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.pos + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.bytes.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  u8(v: number): this {
    this.need(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
    return this;
  }
  u16(v: number): this {
    this.need(2);
    this.view.setUint16(this.pos, v);
    this.pos += 2;
    return this;
  }
  i16(v: number): this {
    this.need(2);
    this.view.setInt16(this.pos, v);
    this.pos += 2;
    return this;
  }
  u32(v: number): this {
    this.need(4);
    this.view.setUint32(this.pos, v >>> 0);
    this.pos += 4;
    return this;
  }
  f32(v: number): this {
    this.need(4);
    this.view.setFloat32(this.pos, v);
    this.pos += 4;
    return this;
  }
  str(s: string): this {
    let b = enc.encode(s);
    if (b.length > 255) {
      // Cut on a character boundary so the truncated text still decodes.
      b = enc.encode(dec.decode(b.subarray(0, 255)).replace(/\uFFFD+$/u, ""));
    }
    this.u8(b.length);
    this.need(b.length);
    this.bytes.set(b, this.pos);
    this.pos += b.length;
    return this;
  }
  /** Append already-encoded bytes. */
  raw(b: Uint8Array): this {
    this.need(b.length);
    this.bytes.set(b, this.pos);
    this.pos += b.length;
    return this;
  }
  /** Angle in radians packed into 16 bits. A non-finite angle is sent as 0. */
  angle(a: number): this {
    const w = Number.isFinite(a) ? wrapAngle(a) : 0;
    return this.i16(Math.round(((w + Math.PI) / (Math.PI * 2)) * 65535) - 32768);
  }
  finish(): Uint8Array {
    return this.bytes.slice(0, this.pos);
  }
  /** Start a new message in the same buffer; `finish` copies, so reuse is safe. */
  reset(): this {
    this.pos = 0;
    return this;
  }
}

export class Reader {
  private view: DataView;
  private bytes: Uint8Array;
  pos = 0;

  constructor(data: ArrayBuffer | Uint8Array) {
    this.bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.byteLength - this.pos;
  }
  u8(): number {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }
  u16(): number {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  i16(): number {
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.pos);
    this.pos += 4;
    return v;
  }
  str(): string {
    const n = this.u8();
    if (n > this.remaining) throw new RangeError("Truncated protocol string");
    const s = dec.decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
  angle(): number {
    return ((this.i16() + 32768) / 65535) * Math.PI * 2 - Math.PI;
  }
}

// ── helpers shared by both sides ─────────────────────────────────────────────

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export function writeBands(w: Writer, bands: string[] | undefined): void {
  const list = (bands ?? []).slice(0, MAX_CUSTOM_BANDS);
  w.u8(list.length);
  for (const c of list) {
    const [r, g, b] = hexToRgb(c);
    w.u8(r).u8(g).u8(b);
  }
}

export function readBands(r: Reader): string[] | undefined {
  const n = r.u8();
  if (!n) return undefined;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(rgbToHex(r.u8(), r.u8(), r.u8()));
  return out;
}

export function writeFood(w: Writer, f: Food): void {
  w.u32(f.id ?? 0)
    .f32(f.x)
    .f32(f.y)
    .u16(Math.min(65535, Math.round(f.v * 10)))
    .u8(f.c)
    .u8(Math.min(255, Math.round(f.r * 4)))
    .u8(f.k);
}

export function readFood(r: Reader): Food {
  return {
    id: r.u32(),
    x: r.f32(),
    y: r.f32(),
    v: r.u16() / 10,
    c: r.u8(),
    r: r.u8() / 4,
    k: r.u8(),
  };
}

/** Write a body, subsampled evenly to at most `max` points (never fewer than two). */
export function writePoints(w: Writer, pts: Vec[], max: number): void {
  let list = pts;
  const keep = Math.max(2, max);
  if (list.length > keep) {
    const out: Vec[] = [];
    const n = list.length - 1;
    for (let i = 0; i < keep; i++) out.push(list[Math.min(n, Math.round((i / (keep - 1)) * n))]!);
    list = out;
  }
  w.u16(list.length);
  for (const p of list) w.f32(p.x).f32(p.y);
}

export function readPoints(r: Reader): Vec[] {
  const n = r.u16();
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) out.push({ x: r.f32(), y: r.f32() });
  return out;
}

export const SNAKE_FULL = 1;
export const SNAKE_BOOST = 2;
export const SNAKE_BOT = 4;
export const SNAKE_INVULN = 8;
export const SNAKE_CROWN = 16;
export const SNAKE_BOSS = 32;
/** The player behind this snake signed in with an account. */
export const SNAKE_LINKED = 64;

/**
 * One snake entry inside a snapshot. `full` includes identity and body.
 * `skinByte` is the wire skin (see `packSkin`); it defaults to the plain skin.
 */
export function writeSnakeEntry(
  w: Writer,
  nid: number,
  s: Snake,
  full: boolean,
  maxPts: number,
  skinByte = s.skin,
): void {
  let flags = 0;
  if (full) flags |= SNAKE_FULL;
  if (s.boosting) flags |= SNAKE_BOOST;
  if (s.isBot) flags |= SNAKE_BOT;
  if (s.invuln > 0) flags |= SNAKE_INVULN;
  if (s.crown) flags |= SNAKE_CROWN;
  if (s.boss) flags |= SNAKE_BOSS;
  if (s.linked) flags |= SNAKE_LINKED;
  w.u16(nid).u8(flags).f32(s.x).f32(s.y).angle(s.angle).f32(s.mass);
  if (full) {
    w.u8(skinByte).str(s.name);
    writeBands(w, s.bands);
    writePoints(w, s.points, maxPts);
  }
}

export interface SnakeEntry {
  nid: number;
  full: boolean;
  boosting: boolean;
  isBot: boolean;
  invuln: boolean;
  crown: boolean;
  boss: boolean;
  linked: boolean;
  x: number;
  y: number;
  angle: number;
  mass: number;
  skin?: number;
  name?: string;
  bands?: string[];
  points?: Vec[];
}

export function readSnakeEntry(r: Reader): SnakeEntry {
  const nid = r.u16();
  const flags = r.u8();
  const e: SnakeEntry = {
    nid,
    full: (flags & SNAKE_FULL) !== 0,
    boosting: (flags & SNAKE_BOOST) !== 0,
    isBot: (flags & SNAKE_BOT) !== 0,
    invuln: (flags & SNAKE_INVULN) !== 0,
    crown: (flags & SNAKE_CROWN) !== 0,
    boss: (flags & SNAKE_BOSS) !== 0,
    linked: (flags & SNAKE_LINKED) !== 0,
    x: r.f32(),
    y: r.f32(),
    angle: r.angle(),
    mass: r.f32(),
  };
  if (e.full) {
    e.skin = r.u8();
    e.name = r.str();
    e.bands = readBands(r);
    e.points = readPoints(r);
  }
  return e;
}
