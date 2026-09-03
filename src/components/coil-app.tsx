import { useEffect, useRef, useState } from "react";
import { Eye, Lock, Share2, Volume2, VolumeX, Zap } from "lucide-react";
import { CoilEngine, type Controls, type HudState } from "@/game/engine";
import { MAX_CUSTOM_BANDS, SKINS } from "@/game/model";

const NICK_KEY = "agencoil-nick";
const SKIN_KEY = "agencoil-skin";
const MUTE_KEY = "agencoil-mute";
const CUSTOM_KEY = "agencoil-custom";
const CONTROLS_KEY = "agencoil-controls";
const BEST_KEY = "agencoil-best";

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
    return Number.isFinite(n) ? n % (SKINS.length + 1) : 0;
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

/** Skin index SKINS.length means "custom". */
const CUSTOM = SKINS.length;

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

  useEffect(() => {
    const n = readNick() || `coil${(Math.random() * 90 + 10) | 0}`;
    setNick(n);
    setSkin(readSkin());
    setCustom(readCustom());
    setMuted(readMuted());
    setTouch(window.matchMedia("(pointer: coarse)").matches);
    setBest(readBest());
    setControls(readControls());
  }, []);

  // The engine keeps `best` current; mirror it whenever the HUD updates so
  // unlocks show up on the next visit to the menu.
  useEffect(() => {
    if (hud && hud.best > best) setBest(hud.best);
  }, [hud, best]);

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

  const play = () => {
    const chosen = locked(skin) ? 0 : skin;
    persist(nick, chosen, custom);
    setShared(false);
    engineRef.current?.play({
      name: nick,
      skin: chosen === CUSTOM ? 0 : chosen,
      bands: chosen === CUSTOM ? custom : undefined,
    });
    engineRef.current?.audio.unlock();
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

  const share = async () => {
    if (!hud) return;
    const text = `I reached length ${hud.score} with ${hud.kills} kill${hud.kills === 1 ? "" : "s"} in AgenCoil. Beat me.`;
    const url = typeof window !== "undefined" ? window.location.origin : "";
    try {
      if (navigator.share) await navigator.share({ title: "AgenCoil", text, url });
      else await navigator.clipboard?.writeText(`${text} ${url}`);
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
      ? `${hud.count} in the arena · ${hud.players} online`
      : hud?.mode === "connecting"
        ? "connecting"
        : "offline · practice arena";

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-bg text-fg">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        style={{ touchAction: "none" }}
      />

      {phase !== "menu" && hud && (
        <div className="pointer-events-none absolute inset-0 p-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="flex items-start justify-between gap-3">
            <div className="rounded-xl border border-line/80 bg-bg/70 px-3 py-2 tabular-nums">
              <div className="text-xs tracking-wide text-muted">your length</div>
              <div className="text-2xl font-semibold leading-tight">{hud.score}</div>
              <div className="mt-0.5 text-xs text-subtle">
                rank {hud.rank} of {hud.count} · kills {hud.kills}
              </div>
              <div className="text-xs text-subtle">best {hud.best}</div>
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
                  ? hud.board.map((r) => ({ name: r.name, n: r.mass, you: r.you }))
                  : hud.daily.map((r) => ({ name: r.name, n: r.best, you: r.name === nick }))
                ).map((row, i) => (
                  <li
                    key={`${row.name}-${i}`}
                    className={row.you ? "font-semibold text-fg" : "text-muted"}
                  >
                    <span className="inline-block w-5 text-subtle">{i + 1}</span>
                    <span className="font-medium">{row.name}</span>
                    <span className="float-right tabular-nums">{row.n}</span>
                  </li>
                ))}
                {boardTab === "today" && hud.daily.length === 0 && (
                  <li className="text-subtle">no scores yet today</li>
                )}
              </ol>
            </div>
          </div>
          <div className="absolute left-4 top-[calc(6.5rem+env(safe-area-inset-top))] rounded-full border border-line bg-bg/70 px-3 py-1 text-xs text-muted">
            {modeLabel}
          </div>
          {hud.killNotice && (
            <div className="absolute left-1/2 top-[calc(6.5rem+env(safe-area-inset-top))] -translate-x-1/2 rounded-full border border-line bg-bg/80 px-4 py-1.5 text-sm">
              {hud.killNotice}
            </div>
          )}
          {hud.feed.length > 0 && (
            <ul className="absolute left-4 top-[calc(8.75rem+env(safe-area-inset-top))] space-y-0.5 text-xs text-muted">
              {hud.feed.map((line, i) => (
                <li key={`${line}-${i}`} className="rounded-full bg-bg/60 px-2 py-0.5">
                  {line}
                </li>
              ))}
            </ul>
          )}
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
          className="absolute inset-0 flex items-end justify-center p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:items-center"
        >
          <div className="w-full max-w-md rounded-xl border border-line bg-surface/92 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
            <div className="flex items-baseline justify-between">
              <p className="text-xs tracking-[0.22em] text-muted uppercase">multiplayer arena</p>
              <p className="text-xs text-subtle">{hud ? modeLabel : ""}</p>
            </div>
            <h1
              className="mt-2 text-5xl font-semibold tracking-tight text-fg"
              style={{ letterSpacing: "-0.04em" }}
            >
              AgenCoil
            </h1>
            <p className="mt-2 text-sm text-muted">
              eat · grow · survive
              {hud?.topToday && (
                <span className="text-subtle">
                  {" "}
                  · top today {hud.topToday.name} {hud.topToday.best}
                </span>
              )}
            </p>

            <label className="mt-6 block text-xs text-muted" htmlFor="nick">
              Nickname
            </label>
            <input
              id="nick"
              value={nick}
              maxLength={16}
              onChange={(e) => setNick(e.target.value)}
              className="mt-1 h-11 w-full rounded-md border border-line bg-elevated px-3 text-fg outline-none focus:border-accent"
            />

            <div className="mt-4 text-xs text-muted">Skin</div>
            <div className="mt-2 grid grid-cols-8 gap-2">
              {SKINS.map((s, i) => (
                <button
                  key={`${s.fill}-${i}`}
                  type="button"
                  aria-label={
                    locked(i) ? `Skin ${i + 1}, unlocks at length ${UNLOCKS[i]}` : `Skin ${i + 1}`
                  }
                  onClick={() => {
                    if (locked(i)) {
                      setLockNote(`reach length ${UNLOCKS[i]} to unlock this skin (best ${best})`);
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
                    onClick={() => setCustom([...custom, custom[custom.length - 1] ?? "#ffffff"])}
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

            <button
              type="button"
              onClick={play}
              className="mt-6 h-12 w-full rounded-lg bg-accent text-base font-medium text-accent-fg transition-transform active:scale-[0.98]"
            >
              Play
            </button>

            <p className="mt-5 text-xs leading-relaxed text-subtle">
              {touch
                ? "Drag to steer. Hold the lightning button to boost. Boosting sheds length behind you."
                : "Mouse or WASD to steer. Hold click, space or shift to boost. Scroll to zoom."}{" "}
              Your head touching any other body pops you. Coil around smaller snakes and eat what
              they leave behind.
            </p>
          </div>
        </div>
      )}

      {phase === "dead" && hud && (
        <div data-ui className="absolute inset-0 flex items-center justify-center p-4">
          <div className="w-full max-w-sm rounded-xl border border-line bg-surface/92 p-6 text-center">
            <p className="text-xs tracking-[0.2em] text-muted uppercase">down</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight">you popped</h2>
            <p className="mt-2 text-sm text-muted">{hud.deathReason}</p>
            {hud.deathRank > 0 && (
              <p className="mt-1 text-xs text-subtle">
                you were #{hud.deathRank} of {hud.deathCount}
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
            <button
              type="button"
              onClick={() => engineRef.current?.respawn()}
              className="mt-6 h-12 w-full rounded-lg bg-accent font-medium text-accent-fg active:scale-[0.98]"
            >
              Play again
            </button>
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
            <p className="mt-3 text-xs text-subtle">tap anywhere or press space</p>
          </div>
        </div>
      )}

      <button
        data-ui
        type="button"
        onClick={toggleMute}
        aria-label={muted ? "Unmute" : "Mute"}
        className="absolute bottom-4 left-4 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-bg/70 text-fg"
      >
        {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
      </button>
    </div>
  );
}
