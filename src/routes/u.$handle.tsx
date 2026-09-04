import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Share2 } from "lucide-react";
import { SKINS } from "@/game/model";
import { LEAGUES, LEAGUE_COLORS, leagueOf, levelOf, titleOf } from "@/game/challenges";
import { ACHIEVEMENTS } from "@/game/achievements";
import { serverHttpUrl } from "@/game/net";

export const Route = createFileRoute("/u/$handle")({ component: ProfilePage });

interface PublicProfile {
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

interface Rarity {
  players: number;
  counts: Record<string, number>;
}

function stripe(bands: string[]): string {
  const n = bands.length;
  const stops = bands.map((c, k) => `${c} ${(k / n) * 100}% ${((k + 1) / n) * 100}%`).join(", ");
  return `linear-gradient(90deg, ${stops})`;
}

function mmss(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function ProfilePage() {
  const { handle } = Route.useParams();
  const [p, setP] = useState<PublicProfile | null>(null);
  const [rarity, setRarity] = useState<Rarity>({ players: 0, counts: {} });
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">("loading");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetch(`${serverHttpUrl()}?profile=${encodeURIComponent(handle)}`)
      .then(async (r) => {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as { profile: PublicProfile; rarity: Rarity };
      })
      .then((j) => {
        if (cancelled) return;
        if (!j) {
          setState("missing");
          return;
        }
        setP(j.profile);
        setRarity(j.rarity);
        setState("ok");
      })
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, [handle]);

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share)
        await navigator.share({ title: "snek", text: `@${handle} on snek`, url });
      else await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* dismissed */
    }
  };

  const bands = p ? (p.bands.length ? p.bands : (SKINS[p.skin]?.bands ?? [])) : [];
  const unlocked = p ? Object.keys(p.achv).length : 0;
  const pct = (id: string): string => {
    if (!rarity.players) return "";
    const n = rarity.counts[id] ?? 0;
    const v = (100 * n) / rarity.players;
    return `${v < 1 ? v.toFixed(1) : Math.round(v)}% of players`;
  };

  return (
    <div className="min-h-dvh w-full bg-bg px-4 py-6 text-fg">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-sm text-muted hover:text-fg">
            <ArrowLeft size={16} /> back to the arena
          </Link>
          <Link to="/top" className="text-xs text-muted hover:text-fg">
            leaderboard
          </Link>
        </div>

        {state === "loading" && <p className="mt-10 text-center text-sm text-muted">loading…</p>}
        {state === "missing" && (
          <p className="mt-10 text-center text-sm text-muted">no snek called @{handle} yet</p>
        )}
        {state === "error" && (
          <p className="mt-10 text-center text-sm text-muted">the arena is not answering</p>
        )}

        {p && state === "ok" && (
          <>
            <div className="mt-6 rounded-xl border border-line bg-surface/92 p-5">
              <div className="flex items-center gap-4">
                {p.avatar ? (
                  <img src={p.avatar} alt="" className="h-16 w-16 rounded-full object-cover" />
                ) : (
                  <span className="grid h-16 w-16 place-items-center rounded-full bg-elevated text-2xl">
                    {(p.name || handle).charAt(0).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-2xl font-semibold tracking-tight">
                    {p.crowned ? "👑 " : ""}
                    {p.crew ? `[${p.crew}] ` : ""}
                    {p.name || handle}
                  </h1>
                  <p className="text-sm text-muted">
                    ✓ @{p.handle} · Lv{levelOf(p.eaten)}
                    {titleOf(p) ? ` · ${titleOf(p)}` : ""}
                  </p>
                  <div
                    className="mt-2 h-2 w-40 rounded-full"
                    style={{ background: bands.length ? stripe(bands) : "#3ee0c4" }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void share()}
                  className="flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-muted hover:text-fg"
                >
                  <Share2 size={14} /> {copied ? "copied" : "share"}
                </button>
              </div>

              <div className="mt-5 grid grid-cols-3 gap-2 text-center tabular-nums sm:grid-cols-6">
                {[
                  ["best", String(p.best)],
                  ["rank", p.rank > 0 ? `#${p.rank}` : "–"],
                  ["kills", String(p.kills)],
                  ["lives", String(p.games)],
                  ["longest life", mmss(p.survive)],
                  ["streak", p.streak > 0 ? `🔥 ${p.streak}d` : "–"],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-line bg-elevated/70 px-2 py-2">
                    <div className="text-[11px] text-muted">{k}</div>
                    <div className="text-lg font-semibold">{v}</div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted">
                {LEAGUES[leagueOf(p.weekBest)]!.name} league this week · week best {p.weekBest} ·
                season best {p.seasonBest}
                {p.prevTier > 0 ? ` · last week ${LEAGUES[p.prevTier - 1]?.name ?? ""}` : ""}
                {" · "}
                {p.bountyTotal} bounties · {p.nearTotal} near misses · {p.chests} chests
              </p>
              <p className="mt-1 text-xs text-muted">
                this week:{" "}
                {p.bankedTier > 0 ? (
                  <span style={{ color: LEAGUE_COLORS[p.bankedTier - 1] }}>
                    {LEAGUES[p.bankedTier - 1]?.name} banked
                  </span>
                ) : (
                  "nothing banked yet"
                )}
                {" · "}
                {p.weekLives} {p.weekLives === 1 ? "life" : "lives"}
                {p.seasonTier > 0 && (
                  <>
                    {" · "}season best banked{" "}
                    <span style={{ color: LEAGUE_COLORS[p.seasonTier - 1] }}>
                      {LEAGUES[p.seasonTier - 1]?.name}
                    </span>
                  </>
                )}
              </p>
              {p.seasons.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {p.seasons.map(([season, tier]) => (
                    <span
                      key={season}
                      className="rounded-md border px-2 py-0.5 text-[11px]"
                      style={{
                        color: LEAGUE_COLORS[tier - 1],
                        borderColor: `${LEAGUE_COLORS[tier - 1]}80`,
                      }}
                      title={`finished season ${season} in ${LEAGUES[tier - 1]?.name}`}
                    >
                      S{season} {LEAGUES[tier - 1]?.name}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-6 flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">achievements</h2>
              <span className="text-xs text-muted">
                {unlocked}/{ACHIEVEMENTS.length}
              </span>
            </div>
            <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {[...ACHIEVEMENTS]
                .sort((a, b) => Number(Boolean(p.achv[b.id])) - Number(Boolean(p.achv[a.id])))
                .map((a) => {
                  const at = p.achv[a.id];
                  return (
                    <li
                      key={a.id}
                      className={`rounded-lg border px-3 py-2 ${at ? "border-[#f0c14a]/50 bg-[#f0c14a]/10" : "border-line bg-surface/60 opacity-60"}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xl">{at ? a.icon : "🔒"}</span>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{a.name}</div>
                          <div className="truncate text-[11px] text-muted">{a.desc}</div>
                        </div>
                      </div>
                      <div className="mt-1 text-[11px] text-subtle">
                        {at ? new Date(at * 1000).toLocaleDateString() : "locked"}
                        {pct(a.id) ? ` · ${pct(a.id)}` : ""}
                      </div>
                    </li>
                  );
                })}
            </ul>

            <Link
              to="/"
              className="mt-8 flex h-12 w-full items-center justify-center rounded-lg bg-accent font-medium text-accent-fg"
            >
              Play snek
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
