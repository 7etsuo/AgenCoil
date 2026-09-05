import { useEffect, useRef } from "react";
import type { Equipped } from "@/game/cosmetics";
import { drawAuraItem, drawBodyItem, drawEyes, drawHeadItem, type Seg } from "@/game/wardrobe-draw";

/**
 * A small live snake in the chosen colours, wiggling across a strip, wearing
 * the wardrobe pieces handed in. Pure canvas, no game state: it exists so the
 * menu shows exactly what the arena will draw.
 */
export function SkinPreview({
  bands,
  boosting = false,
  loadout,
}: {
  bands: string[];
  boosting?: boolean;
  loadout?: Equipped;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const start = performance.now();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const draw = (now: number) => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const t = (now - start) / 1000;
      const r = Math.min(13, h * 0.24);
      const n = 26;
      const step = r * 0.72;
      const amp = h * 0.16;
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < n; i++) {
        const x = w * 0.14 + i * step;
        const y = h / 2 + Math.sin(t * 3.2 - i * 0.55) * amp;
        pts.push({ x, y });
      }
      const head = pts[n - 1]!;
      const prev0 = pts[n - 2]!;
      const heading = Math.atan2(head.y - prev0.y, head.x - prev0.x);
      if (loadout?.aura) drawAuraItem(ctx, loadout.aura, head.x, head.y, r, t);
      if (boosting) {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = bands[0]!;
        ctx.globalAlpha = 0.28 + Math.sin(t * 18) * 0.08;
        ctx.lineWidth = r * 3.6;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
      for (let i = 0; i < n; i++) {
        const p = pts[i]!;
        ctx.beginPath();
        ctx.arc(p.x + r * 0.2, p.y + r * 0.3, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.3)";
        ctx.fill();
      }
      const bandLen = 3;
      for (let i = 0; i < n; i++) {
        const p = pts[i]!;
        const fromHead = n - 1 - i;
        const color = bands[Math.floor(fromHead / bandLen) % bands.length]!;
        const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, 1, p.x, p.y, r);
        g.addColorStop(0, "rgba(255,255,255,0.55)");
        g.addColorStop(0.3, color);
        g.addColorStop(1, "rgba(0,0,0,0.45)");
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.fillStyle = g;
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // Body pieces ride on the discs, counted from the head, with the tangent toward it.
      if (loadout?.body) {
        const segs: Seg[] = [];
        for (let i = n - 1; i >= 0; i--) {
          const p = pts[i]!;
          const q = pts[Math.min(n - 1, i + 1)]!;
          const o = pts[Math.max(0, i - 1)]!;
          const dx = q.x - o.x;
          const dy = q.y - o.y;
          const d = Math.hypot(dx, dy) || 1;
          segs.push({ x: p.x, y: p.y, tx: dx / d, ty: dy / d, i: n - 1 - i });
        }
        drawBodyItem(ctx, loadout.body, segs, r, t);
      }
      if (loadout?.head) drawHeadItem(ctx, loadout.head, head.x, head.y, r, heading, t, boosting);
      // Eyes looking along the path, in the piece worn on them.
      drawEyes(
        ctx,
        loadout?.eyes,
        head.x,
        head.y,
        r,
        heading,
        Math.cos(heading),
        Math.sin(heading),
        t,
      );
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [bands, boosting, loadout]);
  return <canvas ref={ref} className="h-16 w-full" aria-hidden="true" />;
}
