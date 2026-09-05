import {
  LEAGUES,
  LEAGUE_BANK_RUNS,
  LEAGUE_COLORS,
  LEAGUE_LETTERS,
  LEAGUE_SHAPES,
} from "@/game/challenges";
import { CREST_INK, CREST_OUTLINE, crestLetterOffset, crestPolygon } from "@/game/crest";

/**
 * The league crest as an inline SVG, for the menu, the player list, the
 * death card and the pages. `tier` is 1 Bronze to 5 Diamond; 0 renders
 * nothing. Without the letter it is the bare silhouette, used for the bank slots.
 */
export function Crest({
  tier,
  size = 16,
  letter = true,
  dim = false,
  className,
}: {
  tier: number;
  size?: number;
  letter?: boolean;
  dim?: boolean;
  className?: string;
}) {
  const i = tier - 1;
  const shape = LEAGUE_SHAPES[i];
  if (!shape) return null;
  const color = LEAGUE_COLORS[i]!;
  const name = LEAGUES[i]!.name;
  const poly = crestPolygon(shape);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      role="img"
      aria-label={name}
      style={dim ? { opacity: 0.28 } : undefined}
    >
      <title>{name}</title>
      {shape === "circle" && (
        <circle cx="50" cy="50" r="48" fill={color} stroke={CREST_OUTLINE} strokeWidth="3" />
      )}
      {shape === "square" && (
        <rect
          x="2"
          y="2"
          width="96"
          height="96"
          rx="6"
          fill={color}
          stroke={CREST_OUTLINE}
          strokeWidth="3"
        />
      )}
      {poly && (
        <polygon
          points={poly.map(([x, y]) => `${50 + x * 96},${50 + y * 96}`).join(" ")}
          fill={color}
          stroke={CREST_OUTLINE}
          strokeWidth="3"
          strokeLinejoin="round"
        />
      )}
      {shape === "gem" && (
        <line x1="2" y1="40" x2="98" y2="40" stroke={CREST_INK} strokeWidth="3" />
      )}
      {letter && (
        <text
          x="50"
          y={50 + crestLetterOffset(shape) * 100}
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="Outfit, sans-serif"
          fontWeight="700"
          fontSize="62"
          fill={CREST_INK}
        >
          {LEAGUE_LETTERS[i]}
        </text>
      )}
    </svg>
  );
}

/**
 * A player's own bank progress at a tier: three crest-shaped slots, one per
 * run at that tier's length this week. Bronze has no bank reward and no slots.
 */
export function BankSlots({
  tier,
  runs,
  size = 10,
}: {
  tier: number;
  runs: number;
  size?: number;
}) {
  if (tier < 2 || tier > LEAGUES.length) return null;
  return (
    <span
      className="inline-flex items-center gap-0.5 align-middle"
      title={`${Math.min(runs, LEAGUE_BANK_RUNS)} of ${LEAGUE_BANK_RUNS} runs to bank ${LEAGUES[tier - 1]!.name}`}
    >
      {Array.from({ length: LEAGUE_BANK_RUNS }, (_, k) => (
        <Crest key={k} tier={tier} size={size} letter={false} dim={k >= runs} />
      ))}
    </span>
  );
}
