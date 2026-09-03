import { useEffect, useMemo, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { CoilEngine, type HudState } from "@/game/engine";
import { SKINS } from "@/game/model";
import { useP2PRoom } from "@/lib/multiplayer/use-p2p-room";

const NICK_KEY = "agencoil-nick";
const SKIN_KEY = "agencoil-skin";
const MUTE_KEY = "agencoil-mute";

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

export function CoilApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CoilEngine | null>(null);
  const [hud, setHud] = useState<HudState | null>(null);
  const [nick, setNick] = useState("anon");
  const [skin, setSkin] = useState(0);
  const [muted, setMuted] = useState(false);
  const [privateRoom, setPrivateRoom] = useState(false);
  const [code, setCode] = useState("");
  const [invite, setInvite] = useState("");

  useEffect(() => {
    const n = readNick() || `coil${(Math.random() * 90 + 10) | 0}`;
    setNick(n);
    setSkin(readSkin());
    try {
      setMuted(localStorage.getItem(MUTE_KEY) === "1");
    } catch {
      /* ignore */
    }
    const q = new URLSearchParams(window.location.search).get("room");
    if (q) {
      setPrivateRoom(true);
      setCode(q);
    }
  }, []);

  const room = useMemo(() => {
    if (typeof window === "undefined") return "agencoil";
    if (privateRoom && code.trim()) return `agencoil-${code.trim().slice(0, 24)}`;
    return `agencoil-${window.location.hostname.split(".")[0]}`.slice(0, 64);
  }, [privateRoom, code]);

  const p2p = useP2PRoom({ room, name: nick });

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

  const shareRoom = () => {
    const c = code.trim() || Math.random().toString(36).slice(2, 8);
    setCode(c);
    setPrivateRoom(true);
    const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(c)}`;
    setInvite(url);
    void navigator.clipboard?.writeText(url).catch(() => undefined);
  };

  const phase = hud?.phase ?? "menu";

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
              <div className="text-xs tracking-wide text-muted">length</div>
              <div className="text-xl font-medium leading-tight">{hud.score}</div>
              <div className="text-xs text-subtle">best {hud.best}</div>
            </div>
            <div className="hidden min-w-40 rounded-xl border border-line/80 bg-bg/70 px-3 py-2 sm:block">
              <div className="mb-1 text-xs tracking-wide text-muted">arena</div>
              <ol className="space-y-0.5 text-sm">
                {hud.board.map((row, i) => (
                  <li key={`${row.name}-${i}`} className={row.you ? "text-fg" : "text-muted"}>
                    <span className="inline-block w-4 text-subtle">{i + 1}</span>
                    <span className="font-medium">{row.name}</span>
                    <span className="float-right tabular-nums">{row.mass}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <div className="absolute left-4 top-24 rounded-full border border-line bg-bg/70 px-3 py-1 text-xs text-muted">
            {hud.peers > 0 ? `${hud.peers} linked` : hud.joined ? "open arena · bots" : "local · bots"}
          </div>
          {hud.killNotice && (
            <div className="absolute left-1/2 top-24 -translate-x-1/2 rounded-full border border-line bg-bg/80 px-4 py-1.5 text-sm">
              {hud.killNotice}
            </div>
          )}
        </div>
      )}

      {phase === "menu" && (
        <div data-ui className="absolute inset-0 flex items-end justify-center p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:items-center">
          <div className="w-full max-w-md rounded-xl border border-line bg-surface/92 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
            <p className="text-xs tracking-[0.22em] text-muted uppercase">multiplayer arena</p>
            <h1 className="mt-2 text-5xl font-semibold tracking-tight text-fg" style={{ letterSpacing: "-0.04em" }}>
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
                  key={s.fill}
                  type="button"
                  aria-label={`Skin ${i + 1}`}
                  onClick={() => setSkin(i)}
                  className="h-9 w-full rounded-md border"
                  style={{
                    background: s.fill,
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

            <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={privateRoom}
                  onChange={(e) => setPrivateRoom(e.target.checked)}
                />
                Private room
              </label>
              <button type="button" onClick={shareRoom} className="text-fg underline-offset-2 hover:underline">
                Invite
              </button>
            </div>
            {privateRoom && (
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="room code"
                className="mt-2 h-10 w-full rounded-md border border-line bg-elevated px-3 text-sm text-fg outline-none"
              />
            )}
            {invite && <p className="mt-2 break-all text-xs text-subtle">{invite}</p>}

            <p className="mt-5 text-xs leading-relaxed text-subtle">
              Mouse or WASD to steer. Hold click or space to boost. Crash into another body and you pop.
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
            <p className="mt-4 text-sm tabular-nums text-fg">
              length {hud.score} · best {hud.best}
            </p>
            <button
              type="button"
              onClick={() => engineRef.current?.respawn()}
              className="mt-6 h-12 w-full rounded-lg bg-accent font-medium text-accent-fg active:scale-[0.98]"
            >
              Play again
            </button>
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
