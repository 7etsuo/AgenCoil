import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { SKINS } from "@/game/model";
import { LEAGUES, leagueOf } from "@/game/challenges";
import { serverHttpUrl } from "@/game/net";

export const Route = createFileRoute("/top")({ component: TopPage });

interface Row {
  name: string;
  best: number;
  kills: number;
  games: number;
  skin: number;
  bands: string[];
}

type Kind = "alltime" | "weekly" | "season";

function stripe(bands: string[]): string {
  const n = bands.length;
  const stops = bands.map((c, k) => `${c} ${(k / n) * 100}% ${((k + 1) / n) * 100}%`).join(", ");
  return `linear-gradient(90deg, ${stops})`;
}

function TopPage() {
  const [kind, setKind] = useState<Kind>("alltime");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [week, setWeek] = useState("");
  const [season, setSeason] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(false);
    fetch(`${serverHttpUrl()}?top=${kind}`)
      .then((r) => r.json())
      .then((j: { rows: Row[]; week?: string; season?: number }) => {
        if (cancelled) return;
        setRows(j.rows ?? []);
        setWeek(j.week ?? "");
        setSeason(j.season ?? 0);
      })
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [kind]);

  return (
    <div className="min-h-dvh w-full bg-bg px-4 py-6 text-fg">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-sm text-muted hover:text-fg">
            <ArrowLeft size={16} /> back to the arena
          </Link>
          <div className="flex gap-2 text-xs">
            {(["alltime", "weekly", "season"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`rounded-md border px-3 py-1.5 ${kind === k ? "border-accent text-fg" : "border-line text-muted hover:text-fg"}`}
              >
                {k === "alltime"
                  ? "all time"
                  : k === "weekly"
                    ? `this week${week ? ` · ${week}` : ""}`
                    : `season${season ? ` ${season}` : ""}`}
              </button>
            ))}
          </div>
        </div>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight">Top players</h1>
        <p className="mt-1 text-sm text-muted">
          Longest single run,{" "}
          {kind === "alltime" ? "ever" : kind === "weekly" ? "this week" : "this season"}. Kills and
          games are all time.
          {kind === "weekly" && " Leagues promote and relegate every Monday."}
        </p>
        {error && <p className="mt-6 text-sm text-danger">Could not reach the arena server.</p>}
        {rows && rows.length === 0 && !error && (
          <p className="mt-6 text-sm text-subtle">No runs recorded yet.</p>
        )}
        {rows && rows.length > 0 && (
          <ol className="mt-6 divide-y divide-line rounded-xl border border-line bg-surface/80">
            {rows.map((r, i) => (
              <li key={`${r.name}-${i}`} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="w-7 tabular-nums text-subtle">{i + 1}</span>
                <span
                  className="h-4 w-12 shrink-0 rounded-full"
                  style={{
                    background: stripe(
                      r.bands.length ? r.bands : SKINS[r.skin % SKINS.length]!.bands,
                    ),
                  }}
                />
                <span className="flex-1 truncate font-medium">
                  {r.name}
                  {kind === "weekly" && (
                    <span className="ml-2 text-xs text-subtle">
                      {LEAGUES[leagueOf(r.best)]!.name}
                    </span>
                  )}
                  {r.kills >= 50 && <span className="ml-2 text-xs text-[#f0c14a]">Hunter</span>}
                </span>
                <span className="hidden text-xs text-subtle sm:inline">
                  {r.kills} kills · {r.games} games
                </span>
                <span className="w-16 text-right tabular-nums font-semibold">{r.best}</span>
              </li>
            ))}
          </ol>
        )}
        {!rows && !error && <p className="mt-6 text-sm text-subtle">Loading…</p>}
      </div>
    </div>
  );
}
