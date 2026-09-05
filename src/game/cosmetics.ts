/**
 * The wardrobe: cosmetics drawn on the snake that everyone in the arena can
 * see. Shared by the server (grants, equips, purchases, loot rolls) and the
 * client (the menu, the renderer). Nothing here changes how a snake plays.
 *
 * The catalog order is the wire index (position plus one; 0 is an empty
 * slot), so it is append only: never reorder or remove an entry.
 */

export const SLOTS = ["head", "body", "eyes", "aura", "name"] as const;
export type Slot = (typeof SLOTS)[number];

export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;
export type Rarity = (typeof RARITIES)[number];

export const RARITY_COLORS: Record<Rarity, string> = {
  common: "#9aa3b2",
  uncommon: "#4fd18b",
  rare: "#4da3ff",
  epic: "#b56bff",
  legendary: "#ff9f3d",
};

/** Scales paid for a drop the profile already owns, by rarity. */
export const DUPLICATE_SCALES: Record<Rarity, number> = {
  common: 50,
  uncommon: 100,
  rare: 150,
  epic: 400,
  legendary: 1000,
};

export type Source =
  | { kind: "level"; level: number }
  | { kind: "shop"; price: number }
  | { kind: "drop" }
  | { kind: "boss" }
  | { kind: "season"; tier: number }
  | { kind: "feat"; feat: string };

export interface Cosmetic {
  id: string;
  slot: Slot;
  name: string;
  rarity: Rarity;
  source: Source;
  /** A body piece that hides the growth plates and spikes (never the glow). */
  coversGrowth?: boolean;
}

const level = (level: number): Source => ({ kind: "level", level });
const shop = (price: number): Source => ({ kind: "shop", price });
const drop: Source = { kind: "drop" };
const boss: Source = { kind: "boss" };
const season = (tier: number): Source => ({ kind: "season", tier });
const feat = (feat: string): Source => ({ kind: "feat", feat });

export const COSMETICS: readonly Cosmetic[] = [
  { id: "horn_nubs", slot: "head", name: "Horn Nubs", rarity: "common", source: level(5) },
  { id: "party_hat", slot: "head", name: "Party Hat", rarity: "common", source: shop(120) },
  { id: "viking_horns", slot: "head", name: "Viking Horns", rarity: "uncommon", source: shop(300) },
  { id: "antennae", slot: "head", name: "Antennae", rarity: "common", source: drop },
  { id: "devil_horns", slot: "head", name: "Devil Horns", rarity: "uncommon", source: drop },
  { id: "halo", slot: "head", name: "Halo", rarity: "rare", source: level(25) },
  { id: "knight_helm", slot: "head", name: "Knight Helm", rarity: "rare", source: level(50) },
  { id: "kabuto", slot: "head", name: "Kabuto", rarity: "epic", source: drop },
  {
    id: "leviathan_fangs",
    slot: "head",
    name: "Leviathan Fangs",
    rarity: "legendary",
    source: boss,
  },
  {
    id: "diamond_crown",
    slot: "head",
    name: "Diamond Crown",
    rarity: "legendary",
    source: season(5),
  },
  { id: "dorsal_ridge", slot: "body", name: "Dorsal Ridge", rarity: "common", source: level(10) },
  {
    id: "racing_stripes",
    slot: "body",
    name: "Racing Stripes",
    rarity: "common",
    source: shop(150),
  },
  {
    id: "plate_armor",
    slot: "body",
    name: "Plate Armor",
    rarity: "uncommon",
    source: level(20),
    coversGrowth: true,
  },
  { id: "back_spikes", slot: "body", name: "Back Spikes", rarity: "uncommon", source: level(30) },
  { id: "chain_links", slot: "body", name: "Chain Links", rarity: "uncommon", source: level(40) },
  { id: "fin_sail", slot: "body", name: "Fin Sail", rarity: "rare", source: shop(400) },
  { id: "lightning_veins", slot: "body", name: "Lightning Veins", rarity: "rare", source: drop },
  { id: "molten_cracks", slot: "body", name: "Molten Cracks", rarity: "epic", source: drop },
  {
    id: "leviathan_spines",
    slot: "body",
    name: "Leviathan Spines",
    rarity: "epic",
    source: boss,
    coversGrowth: true,
  },
  {
    id: "bone_segments",
    slot: "body",
    name: "Bone Segments",
    rarity: "rare",
    source: feat("hitman"),
  },
  { id: "crystal_shards", slot: "body", name: "Crystal Shards", rarity: "rare", source: level(60) },
  { id: "void_bands", slot: "body", name: "Void Bands", rarity: "rare", source: level(58) },
  { id: "angry_brows", slot: "eyes", name: "Angry Brows", rarity: "common", source: level(15) },
  { id: "cat_eyes", slot: "eyes", name: "Cat Eyes", rarity: "uncommon", source: shop(250) },
  { id: "star_eyes", slot: "eyes", name: "Star Eyes", rarity: "uncommon", source: level(35) },
  { id: "cyber_visor", slot: "eyes", name: "Cyber Visor", rarity: "rare", source: drop },
  {
    id: "vendetta_eyes",
    slot: "eyes",
    name: "Vendetta Eyes",
    rarity: "rare",
    source: feat("payback"),
  },
  { id: "ember_glow", slot: "aura", name: "Ember Glow", rarity: "uncommon", source: level(45) },
  { id: "frost_ring", slot: "aura", name: "Frost Ring", rarity: "rare", source: shop(500) },
  { id: "storm_cloud", slot: "aura", name: "Storm Cloud", rarity: "epic", source: drop },
  { id: "leviathan_dread", slot: "aura", name: "Leviathan Dread", rarity: "epic", source: boss },
  { id: "platinum_sheen", slot: "aura", name: "Platinum Sheen", rarity: "rare", source: season(4) },
  { id: "sun_halo", slot: "aura", name: "Sun Halo", rarity: "rare", source: level(55) },
  { id: "shadow_name", slot: "name", name: "Shadow Name", rarity: "common", source: drop },
  { id: "neon_name", slot: "name", name: "Neon Name", rarity: "uncommon", source: shop(350) },
  { id: "gold_name", slot: "name", name: "Gold Name", rarity: "rare", source: season(3) },
  { id: "rainbow_name", slot: "name", name: "Rainbow Name", rarity: "rare", source: drop },
  { id: "frost_name", slot: "name", name: "Frost Name", rarity: "rare", source: level(52) },
  { id: "royal_name", slot: "name", name: "Royal Name", rarity: "rare", source: shop(900) },
  {
    id: "slayer_name",
    slot: "name",
    name: "Slayer Name",
    rarity: "epic",
    source: feat("boss_slayer"),
  },
];

const BY_ID = new Map<string, Cosmetic>();
const INDEX = new Map<string, number>();
COSMETICS.forEach((c, i) => {
  BY_ID.set(c.id, c);
  INDEX.set(c.id, i + 1);
});

export function cosmeticById(id: string): Cosmetic | undefined {
  return BY_ID.get(id);
}

/** The wire index of an item (1 based; 0 means none). */
export function cosmeticIndex(id: string | undefined | null): number {
  return id ? (INDEX.get(id) ?? 0) : 0;
}

export function cosmeticAt(index: number): Cosmetic | undefined {
  return index >= 1 && index <= COSMETICS.length ? COSMETICS[index - 1] : undefined;
}

/** What a player has on, by slot (ids; a missing slot is empty). */
export type Equipped = Partial<Record<Slot, string>>;

/** The five wire indexes of a loadout, head, body, eyes, aura, name. */
export function loadoutOf(equipped: Equipped | undefined | null): number[] {
  return SLOTS.map((slot) => cosmeticIndex(equipped?.[slot]));
}

/** Back from wire indexes to ids (an index of 0 or out of range is an empty slot). */
export function equippedOf(loadout: readonly number[] | undefined | null): Equipped {
  const out: Equipped = {};
  if (!loadout) return out;
  SLOTS.forEach((slot, i) => {
    const c = cosmeticAt(loadout[i] ?? 0);
    if (c && c.slot === slot) out[slot] = c.id;
  });
  return out;
}

/** Every item a level reaches: the track grants each once. */
export function itemsForLevel(level: number): Cosmetic[] {
  return COSMETICS.filter((c) => c.source.kind === "level" && c.source.level === level);
}

/** Every level-track item at or below a level, for the catch-up grant. */
export function itemsUpToLevel(level: number): Cosmetic[] {
  return COSMETICS.filter((c) => c.source.kind === "level" && c.source.level <= level);
}

export function itemForFeat(feat: string): Cosmetic | undefined {
  return COSMETICS.find((c) => c.source.kind === "feat" && c.source.feat === feat);
}

/** Season finish items for a tier: the tier's own and every lower tier's. */
export function itemsForSeasonTier(tier: number): Cosmetic[] {
  return COSMETICS.filter((c) => c.source.kind === "season" && c.source.tier <= tier);
}

/** Items that drop: everything sold or found, never level, season, feat or boss pieces. */
export function dropPool(rarity?: Rarity): Cosmetic[] {
  return COSMETICS.filter(
    (c) =>
      (c.source.kind === "drop" || c.source.kind === "shop") && (!rarity || c.rarity === rarity),
  );
}

/** A small deterministic hash for weekly rotations, the same on both sides. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const SHOP_SLOTS = 6;

/** This week's shelf: six of the shop items, chosen by the ISO week. */
export function shopFor(week: string): Cosmetic[] {
  return COSMETICS.filter((c) => c.source.kind === "shop")
    .map((c) => ({ c, h: hash(`${week}:${c.id}`) }))
    .sort((a, b) => a.h - b.h)
    .slice(0, SHOP_SLOTS)
    .map((x) => x.c);
}

export function priceOf(c: Cosmetic): number {
  return c.source.kind === "shop" ? c.source.price : 0;
}

/** How a source reads in the menu when the item is locked. */
export function sourceLabel(c: Cosmetic): string {
  const s = c.source;
  switch (s.kind) {
    case "level":
      return `level ${s.level}`;
    case "shop":
      return `shop · ${s.price} scales`;
    case "drop":
      return "a drop from a kill or the boss";
    case "boss":
      return "the leviathan";
    case "season":
      return `a ${["", "Bronze", "Silver", "Gold", "Platinum", "Diamond"][s.tier] ?? ""} season`;
    case "feat":
      return `the ${s.feat.replace(/_/g, " ")} feat`;
  }
}

// ── loot ──────────────────────────────────────────────────────────────────────

export type Roll = { kind: "scales"; scales: number } | { kind: "item"; id: string };

type Rand = () => number;

function pick<T>(list: readonly T[], rand: Rand): T | undefined {
  if (!list.length) return undefined;
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
}

/** A random item of a rarity from the drop pool, preferring one the profile lacks. */
export function dropOf(rarity: Rarity, owned: ReadonlySet<string>, rand: Rand): string | undefined {
  const pool = dropPool(rarity);
  const fresh = pool.filter((c) => !owned.has(c.id));
  return pick(fresh.length ? fresh : pool, rand)?.id;
}

export const BOSS_PART_SCALES = 150;

/**
 * Everyone who cut or rammed the leviathan rolls once: 55% scales, 22% a
 * common drop, 13% a rare drop, 6% Spines, 3% Dread, 1% Fangs.
 */
export function rollBossParticipant(owned: ReadonlySet<string>, rand: Rand): Roll {
  const r = rand() * 100;
  if (r < 55) return { kind: "scales", scales: BOSS_PART_SCALES };
  if (r < 77) return { kind: "item", id: dropOf("common", owned, rand) ?? "antennae" };
  if (r < 90) return { kind: "item", id: dropOf("rare", owned, rand) ?? "lightning_veins" };
  if (r < 96) return { kind: "item", id: "leviathan_spines" };
  if (r < 99) return { kind: "item", id: "leviathan_dread" };
  return { kind: "item", id: "leviathan_fangs" };
}

/** The final blow's guaranteed set piece: 60% Spines, 30% Dread, 10% Fangs. */
export function rollBossFinal(rand: Rand): Roll {
  const r = rand() * 100;
  if (r < 60) return { kind: "item", id: "leviathan_spines" };
  if (r < 90) return { kind: "item", id: "leviathan_dread" };
  return { kind: "item", id: "leviathan_fangs" };
}

/** Kill loot: the victim's length band decides whether an orb drops and what it holds. */
export const KILL_LOOT_BANDS: {
  min: number;
  chance: number;
  /** Cumulative shares of common, uncommon, rare, epic in percent. */
  shares: [number, number, number, number];
}[] = [
  { min: 300, chance: 0.08, shares: [75, 95, 100, 100] },
  { min: 1000, chance: 0.2, shares: [45, 80, 97, 100] },
  { min: 5000, chance: 0.4, shares: [20, 55, 89, 100] },
];

/** The band index for a victim's length, or -1 below the first. */
export function killLootBand(victimLength: number): number {
  let band = -1;
  KILL_LOOT_BANDS.forEach((b, i) => {
    if (victimLength >= b.min) band = i;
  });
  return band;
}

export function killLootChance(victimLength: number): number {
  const b = KILL_LOOT_BANDS[killLootBand(victimLength)];
  return b ? b.chance : 0;
}

/** What a loot orb from a band holds: never a legendary. */
export function rollKillLoot(band: number, owned: ReadonlySet<string>, rand: Rand): Roll {
  const b = KILL_LOOT_BANDS[band] ?? KILL_LOOT_BANDS[0]!;
  const r = rand() * 100;
  const rarity: Rarity =
    r < b.shares[0] ? "common" : r < b.shares[1] ? "uncommon" : r < b.shares[2] ? "rare" : "epic";
  return { kind: "item", id: dropOf(rarity, owned, rand) ?? "antennae" };
}

/** Growth armour, drawn per life from length alone: plates, spikes, a glow. */
export const GROWTH_PLATES = 1000;
export const GROWTH_SPIKES = 5000;
export const GROWTH_GLOW = 20000;
