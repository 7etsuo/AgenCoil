import { useEffect, useRef, useState } from "react";
import {
  Eye,
  Lock,
  Maximize2,
  Minimize2,
  Share2,
  Trophy,
  Users,
  Volume2,
  VolumeX,
  Zap,
} from "lucide-react";
import { CoilEngine, type Controls, type HudState } from "@/game/engine";
import { MAX_CUSTOM_BANDS, SKINS } from "@/game/model";
import {
  DEATH_FX,
  LEAGUES,
  LEAGUE_BANK_RUNS,
  LEAGUE_COLORS,
  rewardText,
  MODES,
  STREAK_MILESTONES,
  TRAILS,
  UNLOCK_DEATH,
  UNLOCK_TRAIL,
  WEEKLY_GOAL,
  isoWeek,
  leagueOf,
  levelOf,
  titleOf,
  weeklySkinFor,
} from "@/game/challenges";
import { Link } from "@tanstack/react-router";
import { Turnstile } from "@/components/turnstile";
import { SkinPreview } from "@/components/skin-preview";
import { ReplayView } from "@/components/replay-view";
import { replayToGif } from "@/lib/replay";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { authEnabled, signIn, signOut } from "@/lib/auth/client";
import { authStatus, mintIdentity } from "@/lib/identity";
import {
  ACHIEVEMENTS,
  MIGHT_PIPS,
  mightPips,
  ACHIEVEMENT_BY_ID,
  groupSummary,
  nextSteps,
  type Totals,
} from "@/game/achievements";

/** A short tag for the process a session is on, so friends can see they share one. */
function arenaLabel(name: string): string {
  if (!name) return "";
  if (name.startsWith("snek-arena-")) return ` · arena ${name.slice(-5)}`;
  if (name.startsWith("dpl_")) return " · fallback server";
  return ` · ${name.slice(-8)}`;
}

/** Lifetime totals from the profile the server streams, for achievement progress. */
function totalsOf(p: NonNullable<HudState["profile"]>): Totals {
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

const NICK_KEY = "agencoil-nick";
const SKIN_KEY = "agencoil-skin";
const MUTE_KEY = "agencoil-mute";
const CUSTOM_KEY = "agencoil-custom";
const CONTROLS_KEY = "agencoil-controls";
const BEST_KEY = "agencoil-best";
const TRAIL_KEY = "agencoil-trail";
const DEATHFX_KEY = "agencoil-deathfx";
const CONFIGURED_TURNSTILE_SITE_KEY = (
  import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined
)?.trim();
const PUBLIC_HOSTNAME = (import.meta.env.VITE_PUBLIC_HOSTNAME as string | undefined)?.trim();
// Grok injects VITE_PUBLIC_HOSTNAME, but it does not carry project-defined
// VITE_* values. The site key is intentionally public; the secret stays only
// on agencoil-server.
const TURNSTILE_SITE_KEY =
  CONFIGURED_TURNSTILE_SITE_KEY ||
  (PUBLIC_HOSTNAME === "snek.grok.me" ? "0x4AAAAAAEl7GSq_ytb3LoEo" : undefined);

function readInt(key: string, max: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n >= 0 && n <= max ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function partyCode(): string {
  return Array.from(
    { length: 5 },
    () => "abcdefghjkmnpqrstuvwxyz23456789"[(Math.random() * 31) | 0],
  ).join("");
}

/** Skins that unlock with your best length: index to required length. */
const UNLOCKS: Record<number, number> = { 12: 120, 13: 300, 14: 600, 15: 1200 };

function readBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY) ?? localStorage.getItem("coil-best")) || 0;
  } catch {
    return 0;
  }
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function readControls(): Controls {
  try {
    return localStorage.getItem(CONTROLS_KEY) === "stick" ? "stick" : "point";
  } catch {
    return "point";
  }
}

function readNick(): string {
  try {
    return localStorage.getItem(NICK_KEY) ?? localStorage.getItem("coil-nick") ?? "";
  } catch {
    return "";
  }
}

function readSkin(): number {
  try {
    const v = localStorage.getItem(SKIN_KEY) ?? localStorage.getItem("coil-skin");
    const n = v ? Number(v) : 0;
    return Number.isFinite(n) ? n % (SKINS.length + 2) : 0;
  } catch {
    return 0;
  }
}

function readCustom(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(list)) {
      const ok = list.filter((c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c));
      if (ok.length) return ok.slice(0, MAX_CUSTOM_BANDS);
    }
  } catch {
    /* ignore */
  }
  return ["#3ee0c4", "#f0c14a", "#e45fa0"];
}

function persist(nick: string, skin: number, custom: string[]): void {
  try {
    localStorage.setItem(NICK_KEY, nick);
    localStorage.setItem(SKIN_KEY, String(skin));
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
  } catch {
    /* ignore */
  }
}

function gradientOf(bands: string[]): string {
  const n = bands.length;
  const stops = bands.map((c, k) => `${c} ${(k / n) * 100}% ${((k + 1) / n) * 100}%`).join(", ");
  return `linear-gradient(90deg, ${stops})`;
}

/** Skin index SKINS.length means "custom"; one past that is this week's skin. */
const CUSTOM = SKINS.length;
const WEEKLY = SKINS.length + 1;

export function CoilApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CoilEngine | null>(null);
  const [hud, setHud] = useState<HudState | null>(null);
  const [nick, setNick] = useState("anon");
  const [skin, setSkin] = useState(0);
  const [custom, setCustom] = useState<string[]>(["#3ee0c4", "#f0c14a", "#e45fa0"]);
  const [muted, setMuted] = useState(false);
  const [touch, setTouch] = useState(false);
  const [boardTab, setBoardTab] = useState<"arena" | "today">("arena");
  const [shared, setShared] = useState(false);
  const [best, setBest] = useState(0);
  const [controls, setControls] = useState<Controls>("point");
  const [lockNote, setLockNote] = useState<string | null>(null);
  const insetRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const lastPhase = useRef<string>("menu");
  const lastNotice = useRef<string | null>(null);
  const engineReady = hud !== null;
  const [trail, setTrail] = useState(0);
  const [deathFx, setDeathFx] = useState(0);
  const [party, setParty] = useState("");
  const [invited, setInvited] = useState(false);
  const [tab, setTab] = useState<"look" | "goals" | "controls">("look");
  const [crew, setCrew] = useState("");
  const [crewSaved, setCrewSaved] = useState(false);
  const [gifState, setGifState] = useState<"idle" | "busy" | "done">("idle");
  const [beatCopied, setBeatCopied] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileReset, setTurnstileReset] = useState(0);
  const [verificationState, setVerificationState] = useState<
    "loading" | "ready" | "verifying" | "error"
  >(TURNSTILE_SITE_KEY ? "loading" : "ready");
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const { user: authUser } = useCurrentUserState();
  const signedIn = Boolean(authUser && !authUser.isDevFallback);
  const [signInReady, setSignInReady] = useState(false);
  const [identity, setIdentity] = useState<{
    ticket: string;
    handle: string;
    name: string;
    avatar: string;
  } | null>(null);

  useEffect(() => {
    const n = readNick() || `coil${(Math.random() * 90 + 10) | 0}`;
    setNick(n);
    setSkin(readSkin());
    setCustom(readCustom());
    setMuted(readMuted());
    setTouch(window.matchMedia("(pointer: coarse)").matches);
    setBest(readBest());
    setControls(readControls());
    setTrail(readInt(TRAIL_KEY, TRAILS.length - 1));
    setDeathFx(readInt(DEATHFX_KEY, DEATH_FX.length - 1));
    const withCode = new URLSearchParams(window.location.search).get("with");
    if (withCode && /^[a-z0-9]{3,12}$/i.test(withCode)) setParty(withCode.toLowerCase());
  }, []);

  useEffect(() => {
    engineRef.current?.setParty(party);
  }, [party, engineReady]);

  // Sign-in is only real where the auth broker knows this deployment.
  useEffect(() => {
    if (!authEnabled) return;
    authStatus()
      .then((s) => setSignInReady(s.configured))
      .catch(() => setSignInReady(false));
  }, []);

  // A signed-in player gets an arena ticket; their account name becomes the
  // default nickname unless they already picked one.
  useEffect(() => {
    if (!signedIn) {
      setIdentity(null);
      return;
    }
    let cancelled = false;
    mintIdentity()
      .then((t) => {
        if (cancelled) return;
        setIdentity(t);
        // Signed in: the account handle is the name, in the arena and offline alike.
        setNick(`@${t.handle}`.slice(0, 16));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  // The engine keeps `best` current; mirror it whenever the HUD updates so
  // unlocks show up on the next visit to the menu.
  useEffect(() => {
    if (hud && hud.best > best) setBest(hud.best);
  }, [hud, best]);

  // Haptics on phones that support it (Android): a tap for a kill, a thud on death.
  useEffect(() => {
    if (!hud) return;
    const vibrate = (ms: number) => {
      try {
        navigator.vibrate?.(ms);
      } catch {
        /* ignore */
      }
    };
    if (hud.phase === "dead" && lastPhase.current !== "dead") vibrate(90);
    if (hud.killNotice && hud.killNotice !== lastNotice.current) vibrate(25);
    lastPhase.current = hud.phase;
    lastNotice.current = hud.killNotice;
  }, [hud]);

  // Safe-area insets, measured from a probe element, so canvas-drawn HUD
  // (the minimap) stays clear of notches and the home indicator.
  useEffect(() => {
    const el = insetRef.current;
    const engine = engineRef.current;
    if (!el || !engine) return;
    const apply = () => {
      const cs = getComputedStyle(el);
      engine.setInsets(parseFloat(cs.paddingTop) || 0, parseFloat(cs.paddingBottom) || 0);
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [engineReady]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    if (!hud?.verificationError) return;
    setTurnstileToken("");
    setVerificationState(TURNSTILE_SITE_KEY ? "loading" : "error");
    setVerificationError(hud.verificationError);
    setTurnstileReset((value) => value + 1);
  }, [hud?.verificationError]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new CoilEngine(canvas);
    engineRef.current = engine;
    // Read the saved preference directly: the state set by the first effect
    // has not re-rendered yet when this runs.
    engine.audio.muted = readMuted();
    engine.setControls(readControls());
    engine.start();
    const unsub = engine.subscribe(setHud);
    return () => {
      unsub();
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  const locked = (i: number) => (UNLOCKS[i] ?? 0) > best;
  const unlocks = hud?.profile?.unlocks ?? 0;
  const trailOpen = (i: number) => i === 0 || (unlocks & (UNLOCK_TRAIL[i] ?? 0)) !== 0;
  const deathOpen = (i: number) => i === 0 || (unlocks & (UNLOCK_DEATH[i] ?? 0)) !== 0;

  const week = isoWeek();
  const weekly = weeklySkinFor(week);
  const weekEarned = hud?.profile?.weekEarned ?? false;
  const weekDone = hud?.profile?.weekDone ?? 0;

  const look = () => {
    let chosen = locked(skin) ? 0 : skin;
    if (chosen === WEEKLY && !weekEarned) chosen = 0;
    return {
      name: nick,
      skin: chosen === CUSTOM || chosen === WEEKLY ? 0 : chosen,
      bands: chosen === CUSTOM ? custom : chosen === WEEKLY ? weekly.bands : undefined,
      trail: trailOpen(trail) ? trail : 0,
      deathFx: deathOpen(deathFx) ? deathFx : 0,
      identity: identity ? { origin: window.location.origin, ticket: identity.ticket } : undefined,
    };
  };

  const play = async () => {
    const engine = engineRef.current;
    if (!engine || verificationState === "verifying") return;
    // Keep audio unlock inside the user gesture even though verification is async.
    engine.audio.unlock();
    const needsVerification = Boolean(TURNSTILE_SITE_KEY) && hud?.mode !== "offline";
    if (needsVerification) {
      if (!turnstileToken) return;
      setVerificationState("verifying");
      setVerificationError(null);
      try {
        await engine.authorize(turnstileToken);
      } catch (error) {
        setTurnstileToken("");
        setVerificationState("error");
        setVerificationError(
          error instanceof Error ? error.message : "Human verification failed. Please try again.",
        );
        setTurnstileReset((value) => value + 1);
        return;
      }
    }
    const chosen = locked(skin) ? 0 : skin;
    persist(nick, chosen, custom);
    try {
      localStorage.setItem(TRAIL_KEY, String(trail));
      localStorage.setItem(DEATHFX_KEY, String(deathFx));
    } catch {
      /* ignore */
    }
    setShared(false);
    engine.play(look());
    setTurnstileToken("");
    setVerificationState("ready");
  };

  const invite = async () => {
    const code = party || partyCode();
    setParty(code);
    const url = `${window.location.origin}${window.location.pathname}?with=${code}`;
    try {
      if (navigator.share) await navigator.share({ title: "snek", text: "Play with me", url });
      else await navigator.clipboard?.writeText(url);
      setInvited(true);
    } catch {
      /* dismissed */
    }
  };

  const toggleMute = () => {
    const next = engineRef.current?.audio.toggleMute() ?? !muted;
    setMuted(next);
    try {
      localStorage.setItem(MUTE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const chooseControls = (mode: Controls) => {
    setControls(mode);
    engineRef.current?.setControls(mode);
    try {
      localStorage.setItem(CONTROLS_KEY, mode);
    } catch {
      /* ignore */
    }
  };

  const toggleFullscreen = () => {
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen?.();
    } catch {
      /* unsupported */
    }
  };
  const canFullscreen =
    typeof document !== "undefined" && Boolean(document.documentElement.requestFullscreen);

  useEffect(() => {
    if (hud?.profile && !crewSaved) setCrew(hud.profile.crew);
  }, [hud?.profile, crewSaved]);

  const saveCrew = () => {
    const tag = crew
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 4);
    setCrew(tag);
    engineRef.current?.setCrew(tag);
    setCrewSaved(true);
    setTimeout(() => setCrewSaved(false), 1500);
  };

  const beatUrl = () =>
    `${window.location.origin}${window.location.pathname}?beat=${hud?.score ?? 0}&by=${encodeURIComponent(nick)}`;

  const copyBeatLink = async () => {
    try {
      const url = beatUrl();
      if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
        await navigator.share({ title: "snek", text: `Beat my ${hud?.score ?? 0} in snek`, url });
      } else await navigator.clipboard?.writeText(url);
      setBeatCopied(true);
    } catch {
      /* dismissed */
    }
  };

  const shareGif = async () => {
    if (!hud?.replay || hud.replay.length < 2 || gifState === "busy") return;
    setGifState("busy");
    try {
      const blob = await replayToGif(hud.replay, hud.deathAt);
      const file = new File([blob], `snek-${Date.now()}.gif`, { type: "image/gif" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "snek",
          text: `My last seconds in snek. ${beatUrl()}`,
        });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      setGifState("done");
    } catch {
      setGifState("idle");
    }
  };

  const share = async () => {
    if (!hud) return;
    const text = `I reached length ${hud.score} with ${hud.kills} kill${hud.kills === 1 ? "" : "s"} in snek. Beat me.`;
    const url = typeof window !== "undefined" ? beatUrl() : "";
    const bands = skin === CUSTOM ? custom : SKINS[skin % SKINS.length]!.bands;
    const blob = await renderShareCard(hud, nick, bands);
    try {
      const file = blob ? new File([blob], "agencoil-run.png", { type: "image/png" }) : null;
      if (file && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: "snek", text, files: [file] });
      } else if (navigator.share) {
        await navigator.share({ title: "snek", text, url });
      } else if (blob) {
        window.open(URL.createObjectURL(blob), "_blank");
      } else {
        await navigator.clipboard?.writeText(`${text} ${url}`);
      }
      setShared(true);
    } catch {
      /* dismissed */
    }
  };

  const phase = hud?.phase ?? "menu";
  const boostOn = () => engineRef.current?.setBoost(true);
  const boostOff = () => engineRef.current?.setBoost(false);
  const modeLabel =
    hud?.mode === "online"
      ? `${hud.count} in the arena · ${hud.players} online${arenaLabel(hud.arena)}`
      : hud?.mode === "connecting"
        ? "connecting"
        : "offline · practice arena";
  const previewBands: string[] =
    skin === CUSTOM
      ? custom
      : skin === WEEKLY
        ? weeklySkinFor(isoWeek()).bands
        : (SKINS[skin] ?? SKINS[0]!).bands;
  const needsVerification = Boolean(TURNSTILE_SITE_KEY) && hud?.mode !== "offline";
  const playDisabled =
    verificationState === "verifying" ||
    (needsVerification && !turnstileToken) ||
    (!TURNSTILE_SITE_KEY && Boolean(hud?.verificationError));

  return (
    <div
      className="relative h-dvh w-full overflow-hidden bg-bg text-fg"
      onContextMenu={(e) => {
        if (phase === "play") e.preventDefault();
      }}
    >
      <div
        ref={insetRef}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 h-0 w-0 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        style={{ touchAction: "none" }}
      />

      {phase !== "menu" && hud && (
        <div className="pointer-events-none absolute inset-0 p-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="flex items-start justify-between gap-3">
            {/* The left stack flows, so the arena line, a beat target and the feed never cover the panel. */}
            <div className="flex flex-col items-start gap-1.5">
              <div className="rounded-xl border border-line/80 bg-bg/70 px-3 py-2 tabular-nums">
                <div className="text-xs tracking-wide text-muted">your length</div>
                <div className="text-2xl font-semibold leading-tight">{hud.score}</div>
                <div className="mt-0.5 text-xs text-subtle">
                  rank {hud.rank} of {hud.count} · kills {hud.kills}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-subtle">
                  <span>best {hud.best}</span>
                  {hud.league > 0 && (
                    <>
                      <span>·</span>
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ background: LEAGUE_COLORS[hud.league - 1] }}
                      />
                      <span style={{ color: LEAGUE_COLORS[hud.league - 1] }}>
                        {LEAGUES[hud.league - 1]?.name}
                      </span>
                      <span
                        className="tracking-[0.15em] text-[#f0c14a]"
                        title={`might: ${hud.might} of ${ACHIEVEMENTS.length} achievements`}
                      >
                        {"●".repeat(mightPips(hud.might))}
                        <span className="text-subtle/60">
                          {"●".repeat(MIGHT_PIPS - mightPips(hud.might))}
                        </span>
                      </span>
                    </>
                  )}
                </div>
                {hud.goal && (
                  <div className="mt-1.5 w-40">
                    <div className="truncate text-[10px] text-subtle">{hud.goal.text}</div>
                    <div className="mt-0.5 h-1 w-full rounded bg-elevated">
                      <div
                        className="h-1 rounded bg-accent"
                        style={{ width: `${Math.min(100, hud.goal.frac * 100)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
              <div className="rounded-full border border-line bg-bg/70 px-3 py-1 text-xs text-muted">
                {modeLabel}
              </div>
              {hud.beat && !hud.beat.done && (
                <div className="rounded-full border border-[#f0c14a]/60 bg-bg/80 px-3 py-1 text-xs text-[#f0c14a]">
                  beat {hud.beat.by} · {hud.score}/{hud.beat.target}
                </div>
              )}
              {hud.feed.length > 0 && (
                <ul className="space-y-0.5 text-xs text-muted">
                  {hud.feed.map((line, i) => (
                    <li key={`${line}-${i}`} className="rounded-full bg-bg/60 px-2 py-0.5">
                      {line}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div
              data-ui
              className="pointer-events-auto hidden min-w-48 rounded-xl border border-line/80 bg-bg/70 px-3 py-2 sm:block"
            >
              <div className="mb-1 flex gap-3 text-xs tracking-wide text-muted">
                <button
                  type="button"
                  onClick={() => setBoardTab("arena")}
                  className={boardTab === "arena" ? "text-fg" : "hover:text-fg"}
                >
                  arena
                </button>
                <button
                  type="button"
                  onClick={() => setBoardTab("today")}
                  className={boardTab === "today" ? "text-fg" : "hover:text-fg"}
                >
                  today
                </button>
              </div>
              <ol className="space-y-0.5 text-sm">
                {(boardTab === "arena"
                  ? hud.board.map((r) => ({
                      name: r.name,
                      n: r.mass,
                      you: r.you,
                      bounty: r.bounty,
                      league: r.league,
                    }))
                  : hud.daily.map((r) => ({
                      name: r.name,
                      n: r.best,
                      you: r.name === nick,
                      bounty: 0,
                      league: 0,
                    }))
                ).map((row, i) => (
                  <li
                    key={`${row.name}-${i}`}
                    className={row.you ? "font-semibold text-fg" : "text-muted"}
                  >
                    <span className="inline-block w-5 text-subtle">{i + 1}</span>
                    {row.league > 0 && (
                      <span
                        className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                        style={{ background: LEAGUE_COLORS[row.league - 1] }}
                        title={LEAGUES[row.league - 1]?.name}
                      />
                    )}
                    <span className="font-medium">{row.name}</span>
                    {row.bounty > 0 && (
                      <span className="ml-1 text-xs text-[#f0c14a]" title="bounty">
                        ★{row.bounty}
                      </span>
                    )}
                    <span className="float-right tabular-nums">{row.n}</span>
                  </li>
                ))}
                {boardTab === "today" && hud.daily.length === 0 && (
                  <li className="text-subtle">no scores yet today</li>
                )}
              </ol>
            </div>
          </div>
          {hud.killNotice && (
            <div className="absolute left-1/2 top-[calc(6.5rem+env(safe-area-inset-top))] -translate-x-1/2 rounded-full border border-line bg-bg/80 px-4 py-1.5 text-sm">
              {hud.killNotice}
            </div>
          )}
          {hud.boss && (
            <div className="absolute left-1/2 top-[calc(1rem+env(safe-area-inset-top))] w-56 -translate-x-1/2 rounded-lg border border-[#ff5a6e]/60 bg-bg/80 px-3 py-1.5 text-center text-xs text-[#ffb3c1]">
              boss · {hud.boss.dir} · {hud.boss.hp}%
              <div className="mt-1 h-1 w-full rounded bg-elevated">
                <div className="h-1 rounded bg-[#ff5a6e]" style={{ width: `${hud.boss.hp}%` }} />
              </div>
            </div>
          )}
          {hud.hint && (
            <div className="absolute left-1/2 top-[calc(9.5rem+env(safe-area-inset-top))] w-max max-w-[80vw] -translate-x-1/2 rounded-full border border-accent/50 bg-bg/85 px-4 py-1.5 text-center text-sm text-fg sm:top-[calc(3.2rem+env(safe-area-inset-top))]">
              {hud.hint}
            </div>
          )}
          {hud.arenaMode.id > 0 && (
            <div className="absolute left-1/2 bottom-[calc(1.25rem+env(safe-area-inset-bottom))] -translate-x-1/2 rounded-full border border-[#9b8cff]/60 bg-bg/80 px-3 py-1 text-xs text-[#c9bfff]">
              {MODES.find((m) => m.id === hud.arenaMode.id)?.name ?? "event"} ·{" "}
              {Math.floor(hud.arenaMode.secsLeft / 60)}:
              {String(hud.arenaMode.secsLeft % 60).padStart(2, "0")} left
            </div>
          )}
          {hud.party.length > 0 && (
            <div className="absolute right-4 top-[calc(3.2rem+env(safe-area-inset-top))] rounded-full border border-line bg-bg/70 px-3 py-1 text-xs text-muted sm:top-[calc(19.5rem+env(safe-area-inset-top))]">
              party {hud.party.map((m) => `${m.name} ${m.mass}`).join(" · ")} · total{" "}
              {hud.party.reduce((a, m) => a + m.mass, hud.score)}
            </div>
          )}
          {hud.bountyOnYou > 0 && (
            <div className="absolute right-4 top-[calc(6.5rem+env(safe-area-inset-top))] rounded-full border border-[#f0c14a]/60 bg-bg/80 px-3 py-1 text-xs text-[#f0c14a] sm:top-[calc(17rem+env(safe-area-inset-top))]">
              ★ bounty on you: {hud.bountyOnYou}
            </div>
          )}
          {hud.event && (
            <div className="absolute left-1/2 top-[calc(1rem+env(safe-area-inset-top))] -translate-x-1/2 rounded-full border border-[#f0c14a]/60 bg-bg/80 px-3 py-1 text-xs text-[#f0c14a]">
              golden swarm to the {hud.event.dir} · {hud.event.left}s
            </div>
          )}
          {hud.nearCombo > 0 && (
            <div className="absolute left-1/2 top-[45%] -translate-x-1/2 text-center">
              <div className="text-2xl font-semibold text-[#f0c14a] drop-shadow">
                close{hud.nearCombo > 1 ? ` x${hud.nearCombo}` : "!"}
              </div>
              <div className="text-xs text-[#f0c14a]/80">+{hud.nearBonus}</div>
            </div>
          )}
        </div>
      )}

      {phase === "play" && touch && (
        <div
          data-ui
          className="absolute bottom-[max(7rem,calc(6.5rem+env(safe-area-inset-bottom)))] right-4 z-10 flex gap-1"
        >
          {["👋", "😮", "😅", "😤"].map((g, i) => (
            <button
              key={g}
              type="button"
              aria-label={`Emote ${i + 1}`}
              onPointerDown={(e) => {
                e.preventDefault();
                engineRef.current?.emote(i);
              }}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-bg/70 text-base"
            >
              {g}
            </button>
          ))}
        </div>
      )}
      {phase === "play" && touch && (
        <button
          data-ui
          type="button"
          aria-label="Boost"
          onPointerDown={(e) => {
            e.preventDefault();
            boostOn();
          }}
          onPointerUp={boostOff}
          onPointerCancel={boostOff}
          onPointerLeave={boostOff}
          onContextMenu={(e) => e.preventDefault()}
          className="absolute bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-4 z-10 flex h-20 w-20 select-none items-center justify-center rounded-full border border-line bg-surface/80 text-fg shadow-[0_8px_30px_rgba(0,0,0,0.45)] active:bg-accent active:text-accent-fg"
          style={{ touchAction: "none" }}
        >
          <Zap size={30} />
        </button>
      )}

      {phase === "menu" && (
        <div
          data-ui
          className="absolute inset-0 flex items-end justify-center overflow-y-auto p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(4.5rem,env(safe-area-inset-top))] sm:items-center sm:pt-4"
        >
          <div className="mt-auto w-full max-w-md rounded-xl border border-line bg-surface/92 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.45)] sm:my-auto sm:p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <SnekMark colors={previewBands} />
                <h1
                  className="text-5xl font-semibold leading-none tracking-tight text-fg sm:text-6xl"
                  style={{ letterSpacing: "-0.05em" }}
                >
                  snek
                </h1>
              </div>
              <p className="text-right text-[11px] leading-tight text-subtle">
                {hud?.watchingTop
                  ? `watching ${hud.watchingTop.name} · ${hud.watchingTop.mass}`
                  : hud
                    ? modeLabel
                    : ""}
                {hud?.topToday && (
                  <>
                    <br />
                    top today {hud.topToday.name} {hud.topToday.best}
                  </>
                )}
              </p>
            </div>
            {hud?.profile && (
              <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                <Chip>Lv{levelOf(hud.profile.eaten)}</Chip>
                {titleOf(hud.profile) && <Chip tone="gold">{titleOf(hud.profile)}</Chip>}
                <Chip>best {hud.profile.best}</Chip>
                <Chip>
                  {hud.profile.rank > 0 ? `#${hud.profile.rank}` : "unranked"}
                  {!hud.profile.persistent && " here"}
                </Chip>
                <Chip tone={hud.profile.streak > 0 ? "fire" : undefined}>
                  🔥 {hud.profile.streak > 0 ? `${hud.profile.streak}d` : "start a streak"}
                </Chip>
                <Chip color={LEAGUE_COLORS[leagueOf(hud.profile.weekBest)]}>
                  {LEAGUES[leagueOf(hud.profile.weekBest)]!.name}
                  {hud.profile.bankedTier > 0
                    ? ` · banked ${LEAGUES[hud.profile.bankedTier - 1]?.name}`
                    : " · nothing banked"}
                </Chip>
                {hud.profile.prevTier > 0 && (
                  <Chip color={LEAGUE_COLORS[hud.profile.prevTier - 1]}>
                    last week {LEAGUES[hud.profile.prevTier - 1]?.name}
                  </Chip>
                )}
                {hud.profile.seasons.length > 0 &&
                  (() => {
                    const best = [...hud.profile.seasons].sort((a, b) => b[1] - a[1])[0]!;
                    return (
                      <Chip color={LEAGUE_COLORS[best[1] - 1]}>
                        S{best[0]} {LEAGUES[best[1] - 1]?.name}
                      </Chip>
                    );
                  })()}
                <Chip>
                  Season {hud.season} ·{" "}
                  {Math.max(1, Math.ceil((hud.seasonEnds - Date.now()) / 86_400_000))}d left
                </Chip>
                {hud.profile.crew && <Chip>[{hud.profile.crew}]</Chip>}
                {!hud.profile.linked && !signedIn && <Chip>guest</Chip>}
                <Chip tone={hud.profile.achv.length > 0 ? "gold" : undefined}>
                  🏆 {hud.profile.achv.length}/{ACHIEVEMENTS.length}
                </Chip>
                {hud.profile.crownSecs > 0 && (
                  <Chip tone="gold">👑 crown · {Math.ceil(hud.profile.crownSecs / 60)}m</Chip>
                )}
                {hud.arenaMode.id > 0 && (
                  <Chip tone="violet">
                    {MODES.find((m) => m.id === hud.arenaMode.id)?.name} ·{" "}
                    {Math.ceil(hud.arenaMode.secsLeft / 60)}m
                  </Chip>
                )}
              </div>
            )}

            {authEnabled && (signInReady || signedIn) && (
              <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-line bg-elevated/60 px-3 py-2 text-xs">
                {signedIn ? (
                  <>
                    <div className="flex min-w-0 items-center gap-2">
                      {authUser?.profileImageUrl ? (
                        <img
                          src={authUser.profileImageUrl}
                          alt=""
                          className="h-6 w-6 rounded-full object-cover"
                        />
                      ) : (
                        <span className="grid h-6 w-6 place-items-center rounded-full bg-bg text-[10px]">
                          ✓
                        </span>
                      )}
                      <span className="truncate text-fg">
                        {authUser?.displayName ?? "signed in"}
                      </span>
                      {(hud?.profile?.handle || identity?.handle) && (
                        <Link
                          to="/u/$handle"
                          params={{ handle: hud?.profile?.handle || identity?.handle || "" }}
                          className="shrink-0 text-muted underline-offset-2 hover:text-fg hover:underline"
                        >
                          profile
                        </Link>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => void signOut(window.location.pathname)}
                      className="shrink-0 text-muted hover:text-fg"
                    >
                      sign out
                    </button>
                  </>
                ) : (
                  <>
                    <span className="text-muted">
                      keep your stats, badge and achievements on every device
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void signIn("grok-x", {
                          callbackURL: window.location.pathname + window.location.search,
                        })
                      }
                      className="shrink-0 rounded-md border border-line bg-bg px-3 py-1.5 font-medium text-fg hover:border-accent"
                    >
                      Sign in with X
                    </button>
                  </>
                )}
              </div>
            )}

            <div className="mt-4 overflow-hidden rounded-lg border border-line bg-bg/60">
              <SkinPreview bands={previewBands} boosting={trail > 0} />
            </div>
            <label className="sr-only" htmlFor="nick">
              Nickname
            </label>
            <div className="mt-3 flex gap-2">
              <input
                id="nick"
                value={nick}
                maxLength={16}
                readOnly={signedIn && identity !== null}
                title={signedIn && identity ? "your handle is your name in the arena" : undefined}
                onChange={(e) => setNick(e.target.value)}
                className={`h-12 flex-1 mt-1 h-11 w-full rounded-md border border-line bg-elevated px-3 text-base text-fg outline-none focus:border-accent ${signedIn && identity ? "text-muted" : ""}`}
              />
              <button
                type="button"
                onClick={() => void play()}
                disabled={playDisabled}
                className="h-12 shrink-0 rounded-lg bg-accent px-7 text-base font-semibold text-accent-fg shadow-[0_0_28px_rgba(215,221,232,0.25)] transition-transform enabled:hover:shadow-[0_0_36px_rgba(215,221,232,0.4)] enabled:active:scale-[0.98] disabled:cursor-wait disabled:opacity-50"
              >
                {verificationState === "verifying" ? "Checking…" : "Play"}
              </button>
            </div>
            {needsVerification && TURNSTILE_SITE_KEY ? (
              <div className="mt-5">
                <Turnstile
                  key={turnstileReset}
                  siteKey={TURNSTILE_SITE_KEY}
                  onToken={(token) => {
                    setTurnstileToken(token);
                    setVerificationError(null);
                    setVerificationState(token ? "ready" : "loading");
                  }}
                  onError={() => {
                    setVerificationState("error");
                    setVerificationError("Human verification could not load. Please try again.");
                  }}
                />
              </div>
            ) : null}

            {verificationError ? (
              <p className="mt-3 text-center text-xs text-danger">{verificationError}</p>
            ) : null}
            {needsVerification && verificationState === "error" ? (
              <button
                type="button"
                onClick={() => {
                  setVerificationError(null);
                  setVerificationState("loading");
                  setTurnstileReset((value) => value + 1);
                }}
                className="mt-2 w-full text-center text-xs text-muted underline decoration-line underline-offset-4 hover:text-fg"
              >
                Retry verification
              </button>
            ) : null}

            <div className="mt-4 flex gap-1 rounded-lg bg-bg/60 p-1 text-xs">
              {(
                [
                  ["look", "your look"],
                  ["goals", "goals"],
                  ["controls", "how to play"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={`flex-1 rounded-md py-1.5 ${tab === id ? "bg-elevated text-fg" : "text-muted hover:text-fg"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === "look" && (
              <>
                <div className="mt-4 text-xs text-muted">Skin</div>
                <div className="mt-2 grid grid-cols-8 gap-2">
                  {SKINS.map((s, i) => (
                    <button
                      key={`${s.fill}-${i}`}
                      type="button"
                      aria-label={
                        locked(i)
                          ? `Skin ${i + 1}, unlocks at length ${UNLOCKS[i]}`
                          : `Skin ${i + 1}`
                      }
                      onClick={() => {
                        if (locked(i)) {
                          setLockNote(
                            `reach length ${UNLOCKS[i]} to unlock this skin (best ${best})`,
                          );
                          return;
                        }
                        setLockNote(null);
                        setSkin(i);
                      }}
                      className="relative h-9 w-full rounded-md border"
                      style={{
                        background: gradientOf(s.bands),
                        borderColor: i === skin ? "#e8eaee" : "transparent",
                        boxShadow: i === skin ? "0 0 0 1px #e8eaee" : "none",
                        opacity: locked(i) ? 0.45 : 1,
                      }}
                    >
                      {locked(i) && (
                        <span className="absolute inset-0 flex items-center justify-center text-fg">
                          <Lock size={14} />
                        </span>
                      )}
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-label="Custom skin"
                    onClick={() => setSkin(CUSTOM)}
                    className="col-span-8 mt-1 flex h-9 items-center justify-between rounded-md border px-3 text-xs"
                    style={{
                      background: gradientOf(custom),
                      borderColor: skin === CUSTOM ? "#e8eaee" : "transparent",
                      boxShadow: skin === CUSTOM ? "0 0 0 1px #e8eaee" : "none",
                    }}
                  >
                    <span className="rounded bg-bg/70 px-2 py-0.5 text-fg">build your own</span>
                  </button>
                </div>
                <button
                  type="button"
                  aria-label={`This week's skin: ${weekly.name}`}
                  onClick={() => {
                    if (!weekEarned) {
                      setLockNote(
                        `finish ${WEEKLY_GOAL} daily challenges this week to earn "${weekly.name}" (${Math.min(weekDone, WEEKLY_GOAL)}/${WEEKLY_GOAL})`,
                      );
                      return;
                    }
                    setLockNote(null);
                    setSkin(WEEKLY);
                  }}
                  className="mt-2 flex h-9 w-full items-center justify-between rounded-md border px-3 text-xs"
                  style={{
                    background: gradientOf(weekly.bands),
                    borderColor: skin === WEEKLY ? "#e8eaee" : "transparent",
                    boxShadow: skin === WEEKLY ? "0 0 0 1px #e8eaee" : "none",
                    opacity: weekEarned ? 1 : 0.6,
                  }}
                >
                  <span className="rounded bg-bg/70 px-2 py-0.5 text-fg">
                    this week only · {weekly.name}
                  </span>
                  <span className="rounded bg-bg/70 px-2 py-0.5 text-fg">
                    {weekEarned
                      ? "earned"
                      : `${Math.min(weekDone, WEEKLY_GOAL)}/${WEEKLY_GOAL} challenges`}
                    {!weekEarned && <Lock size={10} className="ml-1 inline" />}
                  </span>
                </button>
                {lockNote && <p className="mt-2 text-xs text-subtle">{lockNote}</p>}
                {skin === CUSTOM && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {custom.map((c, i) => (
                      <label
                        key={i}
                        className="relative h-9 w-9 overflow-hidden rounded-md border border-line"
                      >
                        <input
                          type="color"
                          value={c}
                          aria-label={`Band ${i + 1} colour`}
                          onChange={(e) =>
                            setCustom(custom.map((x, k) => (k === i ? e.target.value : x)))
                          }
                          className="absolute -inset-2 h-14 w-14 cursor-pointer border-0 bg-transparent p-0"
                        />
                      </label>
                    ))}
                    {custom.length < MAX_CUSTOM_BANDS && (
                      <button
                        type="button"
                        onClick={() =>
                          setCustom([...custom, custom[custom.length - 1] ?? "#ffffff"])
                        }
                        className="h-9 rounded-md border border-line px-3 text-xs text-muted hover:text-fg"
                      >
                        + band
                      </button>
                    )}
                    {custom.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setCustom(custom.slice(0, -1))}
                        className="h-9 rounded-md border border-line px-3 text-xs text-muted hover:text-fg"
                      >
                        remove
                      </button>
                    )}
                  </div>
                )}

                <div className="mt-4 text-xs text-muted">Boost trail</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {TRAILS.map((t, i) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => trailOpen(i) && setTrail(i)}
                      className={`rounded-md border px-3 py-1.5 text-xs ${trail === i ? "border-accent text-fg" : "border-line text-muted hover:text-fg"} ${trailOpen(i) ? "" : "opacity-45"}`}
                    >
                      {t}
                      {!trailOpen(i) && <Lock size={10} className="ml-1 inline" />}
                    </button>
                  ))}
                  <span className="mx-1 self-center text-xs text-subtle">death</span>
                  {DEATH_FX.map((t, i) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => deathOpen(i) && setDeathFx(i)}
                      className={`rounded-md border px-3 py-1.5 text-xs ${deathFx === i ? "border-accent text-fg" : "border-line text-muted hover:text-fg"} ${deathOpen(i) ? "" : "opacity-45"}`}
                    >
                      {t}
                      {!deathOpen(i) && <Lock size={10} className="ml-1 inline" />}
                    </button>
                  ))}
                </div>
                <div className="mt-4 text-xs text-muted">
                  Crew tag · 2 to 4 letters shown before your name
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={crew}
                    onChange={(e) => setCrew(e.target.value.toUpperCase().slice(0, 4))}
                    placeholder="e.g. ACE"
                    maxLength={4}
                    className="h-10 w-28 rounded-lg border border-line bg-bg/60 px-3 text-sm uppercase tracking-widest text-fg outline-none focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={saveCrew}
                    className="h-10 rounded-lg border border-line px-4 text-xs text-muted hover:text-fg"
                  >
                    {crewSaved ? "saved" : crew ? "join crew" : "leave crew"}
                  </button>
                </div>
              </>
            )}
            {tab === "goals" && (
              <>
                {hud?.profile && (
                  <div className="mt-4">
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="text-fg">achievements</span>
                      <span className="text-subtle">
                        {hud.profile.achv.length}/{ACHIEVEMENTS.length}
                        {hud.profile.handle ? " · " : ""}
                        {hud.profile.handle && (
                          <Link
                            to="/u/$handle"
                            params={{ handle: hud.profile.handle }}
                            className="hover:text-fg"
                          >
                            view profile
                          </Link>
                        )}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {groupSummary(new Set(hud.profile.achv)).map(({ a, done }) => (
                        <span
                          key={a.group}
                          title={`${a.name}: ${a.desc}`}
                          className={`rounded-md border px-1.5 py-0.5 text-[11px] ${done ? "border-[#f0c14a]/50 bg-[#f0c14a]/10 text-[#f0c14a]" : "border-line text-subtle opacity-70"}`}
                        >
                          {done ? a.icon : "🔒"} {a.name}
                        </span>
                      ))}
                    </div>
                    <ul className="mt-2 space-y-0.5 text-[11px] text-muted">
                      {nextSteps(totalsOf(hud.profile), new Set(hud.profile.achv), 3).map((s) => (
                        <li key={s.a.id} className="flex justify-between">
                          <span>
                            {s.a.icon} {s.a.name} · {s.a.desc}
                          </span>
                          <span className="tabular-nums text-subtle">
                            {Math.min(s.have, s.a.target ?? 0)}/{s.a.target}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {hud?.profile && (
                  <p className="mt-4 text-xs text-subtle">
                    {hud.profile.streak > 0
                      ? `🔥 ${hud.profile.streak}-day streak`
                      : "🔥 play today to start a streak"}
                    {hud.profile.freezes > 0 ? " · freeze banked" : ""}
                    {(() => {
                      const next = STREAK_MILESTONES.find((m) => m.days > hud.profile!.streak);
                      return next
                        ? ` · ${next.days - hud.profile!.streak} more days to ${next.label}`
                        : "";
                    })()}
                    {" · "}
                    {LEAGUES[leagueOf(hud.profile.weekBest)]!.name} league this week
                    {(() => {
                      const t = leagueOf(hud.profile!.weekBest);
                      const nxt = LEAGUES[t + 1];
                      return nxt ? ` (${nxt.min - hud.profile!.weekBest} to ${nxt.name})` : "";
                    })()}
                    {hud.profile.prevTier > 0 &&
                      ` · finished last week in ${LEAGUES[hud.profile.prevTier - 1]?.name ?? ""}`}
                  </p>
                )}
                {hud && hud.arenaMode.id === 0 && hud.arenaMode.secsToNext > 0 && (
                  <p className="mt-1 text-xs text-subtle">
                    next event in {Math.ceil(hud.arenaMode.secsToNext / 60)} min: every hour, 15
                    minutes of a twist
                  </p>
                )}
                {hud && hud.arenaMode.id > 0 && (
                  <p className="mt-1 text-xs text-[#c9bfff]">
                    event now: {MODES.find((m) => m.id === hud.arenaMode.id)?.text} ·{" "}
                    {Math.ceil(hud.arenaMode.secsLeft / 60)} min left
                  </p>
                )}
                {hud?.profile && (
                  <div className="mt-4 rounded-lg border border-line bg-bg/40 px-3 py-2 text-xs">
                    <div className="text-fg">
                      League stakes · {LEAGUE_BANK_RUNS} lives at a tier&apos;s length bank it for
                      the week
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-subtle">
                      {LEAGUES.map((l, i) => (
                        <span key={l.name}>
                          <span style={{ color: LEAGUE_COLORS[i] }}>{l.name}</span>{" "}
                          {i > 0 ? `${l.min}+` : "any"} · {hud.profile!.weekRuns[i] ?? 0}/
                          {LEAGUE_BANK_RUNS}
                        </span>
                      ))}
                    </div>
                    <div className="mt-1 text-subtle">
                      Pays on the roll:{" "}
                      {LEAGUES.slice(1)
                        .map((l, i) => `${l.name} ${rewardText(i + 2)}`)
                        .join("; ")}
                      . The best banked tier of the season stays on your profile as a title.
                    </div>
                  </div>
                )}
                {hud?.challenges && hud.challenges.length > 0 && (
                  <div className="mt-4">
                    <div className="text-xs text-muted">
                      Today&apos;s quest chain · finish all three to open a chest
                      {hud.profile && (
                        <span className="text-subtle"> · shards {hud.profile.shards}/3</span>
                      )}
                    </div>
                    <ul className="mt-2 space-y-1.5">
                      {hud.challenges.map((c, i) => {
                        const activeIdx = hud.challenges.findIndex((x) => !x.done);
                        const locked = !c.done && i !== activeIdx;
                        return (
                          <li key={c.id} className={`text-xs ${locked ? "opacity-45" : ""}`}>
                            <div className="flex justify-between">
                              <span
                                className={
                                  c.done ? "text-fg" : i === activeIdx ? "text-fg" : "text-muted"
                                }
                              >
                                {c.done ? "✓ " : locked ? "🔒 " : "▶ "}
                                step {i + 1}: {c.text}
                              </span>
                              <span className="tabular-nums text-subtle">
                                {Math.min(c.progress, c.target)}/{c.target}
                              </span>
                            </div>
                            <div className="mt-1 h-1 w-full rounded bg-elevated">
                              <div
                                className={`h-1 rounded ${c.done ? "bg-[#f0c14a]" : "bg-accent"}`}
                                style={{
                                  width: `${Math.min(100, (c.progress / c.target) * 100)}%`,
                                }}
                              />
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </>
            )}
            {tab === "controls" && (
              <>
                {touch && (
                  <div className="mt-4 flex items-center gap-2 text-xs text-muted">
                    <span>Steering</span>
                    {(["point", "stick"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => chooseControls(m)}
                        className={`rounded-md border px-3 py-1.5 ${controls === m ? "border-accent text-fg" : "border-line hover:text-fg"}`}
                      >
                        {m === "point" ? "follow finger" : "joystick"}
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-4 text-xs leading-relaxed text-muted">
                  {touch
                    ? "Drag to steer. Hold the lightning button, or a second finger anywhere, to boost. Boosting sheds length behind you."
                    : "Mouse or WASD to steer. Hold click, space or shift to boost."}{" "}
                  Your head touching any other body pops you. Coil around smaller snakes and eat
                  what they leave behind.
                </p>
                <p className="mt-2 text-xs text-muted">
                  Keys 1 to 4 send an emote. The view zooms out on its own as you grow.
                </p>
              </>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => void invite()}
                className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-line text-sm text-muted hover:text-fg"
              >
                <Users size={16} />
                {invited
                  ? "invite link copied"
                  : party
                    ? `playing with friends · ${party}`
                    : "play with friends"}
              </button>
              <Link
                to="/top"
                className="flex h-10 items-center justify-center gap-2 rounded-lg border border-line px-3 text-sm text-muted hover:text-fg"
              >
                <Trophy size={16} />
                top players
              </Link>
            </div>
          </div>
        </div>
      )}

      {phase === "wisp" && hud?.wisp && (
        <div
          data-ui
          className="absolute left-1/2 top-[calc(1rem+env(safe-area-inset-top))] flex -translate-x-1/2 flex-col items-center gap-2"
        >
          <div className="rounded-full border border-[#bfe9ff]/50 bg-bg/85 px-4 py-1.5 text-center text-sm text-fg">
            you are a wisp · glide over orbs to bank starting length · +{hud.wisp.bank} banked ·{" "}
            {hud.wisp.secsLeft}s
          </div>
          <button
            type="button"
            onClick={() => engineRef.current?.endWisp()}
            className="rounded-full border border-line bg-bg/80 px-4 py-1.5 text-xs text-muted hover:text-fg"
          >
            done · keep +{hud.wisp.bank}
          </button>
        </div>
      )}
      {phase === "dead" && hud && !hud.deathBeat && (
        <div data-ui className="absolute inset-0 flex items-center justify-center p-4">
          <div className="w-full max-w-sm rounded-xl border border-line bg-surface/92 p-6 text-center">
            <p className="text-xs tracking-[0.2em] text-muted uppercase">down</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight">
              {hud.nearWin ? "so close" : "you popped"}
            </h2>
            <p className="mt-2 text-sm text-muted">
              {hud.nearWin ? `${hud.nearWin} · ` : ""}
              {hud.deathReason}
            </p>
            {hud.banked > 0 && (
              <p className="mt-1 text-xs text-[#bfe9ff]">
                your wisp banked +{hud.banked} starting length for this life
              </p>
            )}
            {hud.profile &&
              (() => {
                const tier = leagueOf(hud.score);
                if (tier <= 0) return null;
                const runs = hud.profile.weekRuns[tier] ?? 0;
                const name = LEAGUES[tier]!.name;
                return (
                  <p className="mt-1 text-xs" style={{ color: LEAGUE_COLORS[tier] }}>
                    {runs >= LEAGUE_BANK_RUNS
                      ? `${name} is banked for the week`
                      : `a ${name} run · ${runs}/${LEAGUE_BANK_RUNS} to bank it`}
                  </p>
                );
              })()}
            {hud.replay && hud.replay.length > 1 && (
              <div className="mt-4 overflow-hidden rounded-lg border border-line">
                <ReplayView frames={hud.replay} at={hud.deathAt} />
              </div>
            )}
            {hud.deathRank > 0 && (
              <p className="mt-1 text-xs text-subtle">
                you were #{hud.deathRank} of {hud.deathCount}
                {hud.firstLife && hud.deathCount > hud.deathRank
                  ? ` · you beat ${hud.deathCount - hud.deathRank}. one more?`
                  : ""}
              </p>
            )}
            <div className="mt-5 grid grid-cols-3 gap-2 text-center tabular-nums">
              <div className="rounded-lg border border-line bg-elevated/70 px-2 py-2">
                <div className="text-xs text-muted">length</div>
                <div className="text-xl font-semibold">{hud.score}</div>
              </div>
              <div className="rounded-lg border border-line bg-elevated/70 px-2 py-2">
                <div className="text-xs text-muted">kills</div>
                <div className="text-xl font-semibold">{hud.kills}</div>
              </div>
              <div className="rounded-lg border border-line bg-elevated/70 px-2 py-2">
                <div className="text-xs text-muted">best</div>
                <div className="text-xl font-semibold">{hud.best}</div>
              </div>
            </div>
            {hud.unlocked.length > 0 && (
              <div className="mt-3 rounded-lg border border-[#f0c14a]/50 bg-[#f0c14a]/10 px-3 py-2 text-left text-xs">
                <div className="text-[10px] tracking-[0.2em] text-[#f0c14a] uppercase">
                  unlocked
                </div>
                {hud.unlocked.map((id) => {
                  const a = ACHIEVEMENT_BY_ID.get(id);
                  return a ? (
                    <div key={id} className="text-[#f0c14a]">
                      {a.icon} {a.name} <span className="text-muted">· {a.desc}</span>
                    </div>
                  ) : null;
                })}
              </div>
            )}
            {hud.profile &&
              (() => {
                const steps = nextSteps(totalsOf(hud.profile), new Set(hud.profile.achv), 2);
                return steps.length ? (
                  <ul className="mt-2 space-y-0.5 text-left text-xs text-muted">
                    {steps.map((s) => (
                      <li key={s.a.id} className="flex justify-between">
                        <span>
                          {s.a.icon} {(s.a.target ?? 0) - Math.min(s.have, s.a.target ?? 0)} more to{" "}
                          {s.a.name}
                        </span>
                        <span className="tabular-nums text-subtle">
                          {Math.min(s.have, s.a.target ?? 0)}/{s.a.target}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null;
              })()}
            {authEnabled && signInReady && !signedIn && (
              <button
                type="button"
                onClick={() =>
                  void signIn("grok-x", {
                    callbackURL: window.location.pathname + window.location.search,
                  })
                }
                className="mt-3 h-10 w-full rounded-lg border border-line text-sm text-muted hover:text-fg"
              >
                Sign in with X to keep your stats
              </button>
            )}
            {hud.rematch && (
              <button
                type="button"
                onClick={() => engineRef.current?.respawn(false, true)}
                className="mt-5 h-12 w-full rounded-lg border border-[#ff6b8a] bg-[#ff6b8a]/15 font-medium text-[#ffb3c1] active:scale-[0.98]"
              >
                Rematch · spawn next to {hud.rematch.name}
              </button>
            )}
            {hud.comebackLeft > 0 && (
              <button
                type="button"
                onClick={() => engineRef.current?.respawn(true)}
                className="mt-5 h-12 w-full rounded-lg border border-[#f0c14a] bg-[#f0c14a]/15 font-medium text-[#f0c14a] active:scale-[0.98]"
              >
                Rise again with a quarter of your length · {hud.comebackLeft}s
              </button>
            )}
            <button
              type="button"
              onClick={() => engineRef.current?.respawn()}
              className={`${hud.comebackLeft > 0 || hud.rematch ? "mt-2" : "mt-6"} h-12 w-full rounded-lg bg-accent font-medium text-accent-fg active:scale-[0.98] ${hud.nearWin ? "h-14 text-lg shadow-[0_0_28px_rgba(215,221,232,0.35)]" : ""}`}
            >
              {hud.nearWin ? "Run it back" : "Play again"}
            </button>
            {hud.challenges.length > 0 && (
              <ul className="mt-3 space-y-0.5 text-left text-xs text-muted">
                {hud.challenges.map((c) => (
                  <li key={c.id} className="flex justify-between">
                    <span className={c.done ? "text-fg" : ""}>
                      {c.done ? "✓ " : ""}
                      {c.text}
                    </span>
                    <span className="tabular-nums text-subtle">
                      {Math.min(c.progress, c.target)}/{c.target}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {hud.watchable.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs text-muted">
                <Eye size={14} />
                {hud.watchable.map((w) => (
                  <button
                    key={w.nid}
                    type="button"
                    onClick={() => engineRef.current?.watch(hud.watching === w.nid ? null : w.nid)}
                    className={`rounded-full border px-2.5 py-1 ${hud.watching === w.nid ? "border-accent text-fg" : "border-line hover:text-fg"}`}
                  >
                    {w.name}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => void share()}
              className="mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-line text-sm text-muted hover:text-fg"
            >
              <Share2 size={16} /> {shared ? "copied" : "share your run"}
            </button>
            <div className="mt-2 flex gap-2">
              {hud.replay && hud.replay.length > 1 && (
                <button
                  type="button"
                  onClick={() => void shareGif()}
                  className="flex h-10 flex-1 items-center justify-center rounded-lg border border-line text-xs text-muted hover:text-fg"
                >
                  {gifState === "busy"
                    ? "making gif…"
                    : gifState === "done"
                      ? "gif saved"
                      : "share replay as gif"}
                </button>
              )}
              <button
                type="button"
                onClick={() => void copyBeatLink()}
                className="flex h-10 flex-1 items-center justify-center rounded-lg border border-line text-xs text-muted hover:text-fg"
              >
                {beatCopied ? "link copied" : "beat my run link"}
              </button>
            </div>
            <p className="mt-3 text-xs text-subtle">tap anywhere or press space</p>
          </div>
        </div>
      )}

      <div
        data-ui
        className={
          phase === "menu"
            ? "absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-10 flex gap-2"
            : "absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-4 z-10 flex gap-2"
        }
      >
        <button
          type="button"
          onClick={toggleMute}
          aria-label={muted ? "Unmute" : "Mute"}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-bg/70 text-fg"
        >
          {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
        {touch && canFullscreen && (
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-bg/70 text-fg"
          >
            {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
        )}
      </div>
    </div>
  );
}

/** A 1200x630 PNG of the run for sharing. */
async function renderShareCard(hud: HudState, nick: string, bands: string[]): Promise<Blob | null> {
  try {
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 630;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#07090f";
    ctx.fillRect(0, 0, 1200, 630);
    for (let i = 0; i < 120; i++) {
      ctx.fillStyle = `hsla(${(i * 47) % 360} 80% 65% / 0.55)`;
      ctx.beginPath();
      ctx.arc((i * 733) % 1200, (i * 389) % 630, 2 + (i % 4), 0, Math.PI * 2);
      ctx.fill();
    }
    // Snake stripe in the player's skin.
    const n = bands.length;
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = bands[Math.floor(i / 2) % n]!;
      ctx.beginPath();
      ctx.arc(140 + i * 42, 470 + Math.sin(i * 0.6) * 28, 34, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#e8eaee";
    ctx.font = "600 64px Outfit, system-ui, sans-serif";
    ctx.fillText("snek", 80, 130);
    ctx.font = "500 34px Outfit, system-ui, sans-serif";
    ctx.fillStyle = "#8b93a1";
    ctx.fillText(nick, 80, 190);
    ctx.fillStyle = "#e8eaee";
    ctx.font = "600 96px Outfit, system-ui, sans-serif";
    ctx.fillText(String(hud.score), 80, 320);
    ctx.font = "500 30px Outfit, system-ui, sans-serif";
    ctx.fillStyle = "#8b93a1";
    ctx.fillText(
      `length · ${hud.kills} kill${hud.kills === 1 ? "" : "s"} · #${hud.deathRank || hud.rank} of ${hud.deathCount || hud.count}`,
      80,
      370,
    );
    ctx.fillStyle = "#5c6573";
    ctx.font = "500 26px Outfit, system-ui, sans-serif";
    ctx.fillText(window.location.host, 80, 590);
    return await new Promise((resolve) => c.toBlob((b) => resolve(b), "image/png"));
  } catch {
    return null;
  }
}

function Chip({
  children,
  tone,
  color,
}: {
  children: React.ReactNode;
  tone?: "gold" | "fire" | "violet";
  /** An explicit colour (a league's), which wins over the tone. */
  color?: string;
}) {
  const cls =
    tone === "gold"
      ? "border-[#f0c14a]/50 text-[#f0c14a]"
      : tone === "fire"
        ? "border-[#ff8a3d]/50 text-[#ffb27a]"
        : tone === "violet"
          ? "border-[#9b8cff]/50 text-[#c9bfff]"
          : "border-line text-muted";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 leading-tight ${color ? "" : cls}`}
      style={color ? { color, borderColor: `${color}80` } : undefined}
    >
      {children}
    </span>
  );
}

/** The snek mark: a coiled S in the chosen skin's first two colours. */
function SnekMark({ colors }: { colors: string[] }) {
  const a = colors[0] ?? "#2ad3b5";
  const b = colors[1] ?? colors[0] ?? "#ffd166";
  return (
    <svg width="52" height="52" viewBox="0 0 64 64" aria-hidden="true" className="shrink-0">
      <defs>
        <linearGradient id="snekmark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={a} />
          <stop offset="1" stopColor={b} />
        </linearGradient>
      </defs>
      <path
        d="M46 14c-6-6-22-6-24 4s16 8 22 14-2 18-14 18-16-6-18-10"
        fill="none"
        stroke="rgba(0,0,0,0.45)"
        strokeWidth="14"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="translate(2 3)"
      />
      <path
        d="M46 14c-6-6-22-6-24 4s16 8 22 14-2 18-14 18-16-6-18-10"
        fill="none"
        stroke="url(#snekmark)"
        strokeWidth="12"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="45" cy="13" r="6.5" fill={a} />
      <circle cx="47.5" cy="11.5" r="2.4" fill="#fff" />
      <circle cx="48.2" cy="11.8" r="1.1" fill="#101318" />
    </svg>
  );
}
