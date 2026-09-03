import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX, Zap } from "lucide-react";
import { CoilEngine, type HudState } from "@/game/engine";
import { SKINS } from "@/game/model";
import { useP2PRoom } from "@/lib/multiplayer/use-p2p-room";

const NICK_KEY = "agencoil-nick";
const SKIN_KEY = "agencoil-skin";
const MUTE_KEY = "agencoil-mute";
const ARENA = "agencoil-arena";

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
    return Number.isFinite(n) ? n % SKINS.length : 0;
  } catch {
    return 0;
  }
}

function persist(nick: string, skin: number): void {
  try {
    localStorage.setItem(NICK_KEY, nick);
    localStorage.setItem(SKIN_KEY, String(skin));
  } catch {
    /* ignore */
  }
}

function skinGradient(i: number): string {
  const s = SKINS[i % SKINS.length]!;
  const n = s.bands.length;
  const stops = s.bands.map((c, k) => `${c} ${(k / n) * 100}% ${((k + 1) / n) * 100}%`).join(", ");
  return `linear-gradient(90deg, ${stops})`;
}

export function CoilApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CoilEngine | null>(null);
  const [hud, setHud] = useState<HudState | null>(null);
  const [nick, setNick] = useState("anon");
  const [skin, setSkin] = useState(0);
  const [muted, setMuted] = useState(false);
  const [touch, setTouch] = useState(false);

  useEffect(() => {
    const n = readNick() || `coil${(Math.random() * 90 + 10) | 0}`;
    setNick(n);
    setSkin(readSkin());
    try {
      setMuted(localStorage.getItem(MUTE_KEY) === "1");
    } catch {
      /* ignore */
    }
    setTouch(window.matchMedia("(pointer: coarse)").matches);
  }, []);

  // One public arena for everyone; the hook shards it when a mesh fills up.
  const p2p = useP2PRoom({ room: ARENA, name: nick });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new CoilEngine(canvas);
    engineRef.current = engine;
    engine.audio.muted = muted;
    engine.start();
    const unsub = engine.subscribe(setHud);
    return () => {
      unsub();
      engine.destroy();
      engineRef.current = null;
    };
    // room changes remount via key on parent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setNet({
      selfId: p2p.selfId,
      peers: p2p.peers,
      joined: p2p.joined,
      broadcast: p2p.broadcast,
      send: p2p.send,
      onMessage: p2p.onMessage,
    });
  }, [p2p]);

  const play = () => {
    persist(nick, skin);
    engineRef.current?.play(nick, skin);
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

  const phase = hud?.phase ?? "menu";
  const boostOn = () => engineRef.current?.setBoost(true);
  const boostOff = () => engineRef.current?.setBoost(false);

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
            <div className="hidden min-w-44 rounded-xl border border-line/80 bg-bg/70 px-3 py-2 sm:block">
              <div className="mb-1 text-xs tracking-wide text-muted">leaderboard</div>
              <ol className="space-y-0.5 text-sm">
                {hud.board.map((row, i) => (
                  <li
                    key={`${row.name}-${i}`}
                    className={row.you ? "font-semibold text-fg" : "text-muted"}
                  >
                    <span className="inline-block w-5 text-subtle">{i + 1}</span>
                    <span className="font-medium">{row.name}</span>
                    <span className="float-right tabular-nums">{row.mass}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <div className="absolute left-4 top-[calc(6.5rem+env(safe-area-inset-top))] rounded-full border border-line bg-bg/70 px-3 py-1 text-xs text-muted">
            {`${hud.count} in the arena`}
            {hud.peers > 0 ? ` · ${hud.peers} linked` : ""}
          </div>
          {hud.killNotice && (
            <div className="absolute left-1/2 top-[calc(6.5rem+env(safe-area-inset-top))] -translate-x-1/2 rounded-full border border-line bg-bg/80 px-4 py-1.5 text-sm">
              {hud.killNotice}
            </div>
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
            <p className="text-xs tracking-[0.22em] text-muted uppercase">multiplayer arena</p>
            <h1
              className="mt-2 text-5xl font-semibold tracking-tight text-fg"
              style={{ letterSpacing: "-0.04em" }}
            >
              AgenCoil
            </h1>
            <p className="mt-2 text-sm text-muted">eat · grow · survive</p>

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
                  aria-label={`Skin ${i + 1}`}
                  onClick={() => setSkin(i)}
                  className="h-9 w-full rounded-md border"
                  style={{
                    background: skinGradient(i),
                    borderColor: i === skin ? "#e8eaee" : "transparent",
                    boxShadow: i === skin ? "0 0 0 1px #e8eaee" : "none",
                  }}
                />
              ))}
            </div>

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
