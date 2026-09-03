import { useEffect, useRef } from "react";
import type { ReplayFrame } from "@/game/engine";
import type { Vec } from "@/game/model";

/**
 * The last seconds before death, replayed from recorded world state: nearby
 * snakes as their body paths, you outlined in white, looping over the card.
 */
export function ReplayView({ frames, at }: { frames: ReplayFrame[]; at: Vec | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || frames.length < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const t0 = frames[0]!.t;
    const span = Math.max(500, frames[frames.length - 1]!.t - t0);
    const start = performance.now();
    let raf = 0;
    const fallback = at ??
      frames[frames.length - 1]!.snakes.find((s) => s.me)?.pts.at(-1) ?? { x: 0, y: 0 };
    // The camera follows your head through the clip, as it did in play.
    let centre = { ...fallback };
    const draw = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#07090f";
      ctx.fillRect(0, 0, w, h);
      // Loop with a short hold on the final frame.
      const loop = span + 900;
      const tt = (performance.now() - start) % loop;
      const target = t0 + Math.min(span, tt);
      let i = 0;
      while (i < frames.length - 1 && frames[i + 1]!.t <= target) i++;
      const f = frames[i]!;
      const scale = w / 900;
      const meHead = f.snakes.find((s) => s.me)?.pts.at(-1);
      const want = meHead ?? fallback;
      centre =
        tt < 50
          ? { ...want }
          : { x: centre.x + (want.x - centre.x) * 0.25, y: centre.y + (want.y - centre.y) * 0.25 };
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, (w / 2) * dpr, (h / 2) * dpr);
      ctx.translate(-centre.x, -centre.y);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const ordered = f.snakes.slice().sort((a, b) => (a.me ? 1 : 0) - (b.me ? 1 : 0));
      for (const s of ordered) {
        ctx.beginPath();
        s.pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        if (s.me) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = s.r * 2 + 6 / scale;
          ctx.stroke();
        }
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.r * 2;
        ctx.stroke();
        const head = s.pts[s.pts.length - 1]!;
        ctx.beginPath();
        ctx.arc(head.x, head.y, s.r * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = "#101318";
        ctx.fill();
      }
      // Progress bar and the death flash on the last frame.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (tt >= span) {
        ctx.fillStyle = `rgba(255,255,255,${0.35 * Math.max(0, 1 - (tt - span) / 500)})`;
        ctx.fillRect(0, 0, w, h);
      }
      ctx.fillStyle = "rgba(232,234,238,0.25)";
      ctx.fillRect(0, h - 2, w * Math.min(1, tt / span), 2);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [frames, at]);
  return (
    <canvas ref={ref} className="h-40 w-full rounded-lg" aria-label="replay of your last seconds" />
  );
}
