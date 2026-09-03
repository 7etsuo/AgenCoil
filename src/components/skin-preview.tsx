import { useEffect, useRef } from "react";

/**
 * A small live snake in the chosen colours, wiggling across a strip. Pure
 * canvas, no game state: it exists so the menu shows what you will look like.
 */
export function SkinPreview({ bands, boosting = false }: { bands: string[]; boosting?: boolean }) {
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
      // Eyes looking along the path.
      const prev = pts[n - 2]!;
      const ang = Math.atan2(head.y - prev.y, head.x - prev.x);
      const ex = Math.cos(ang);
      const ey = Math.sin(ang);
      for (const side of [-1, 1]) {
        const cx = head.x + ex * r * 0.36 - ey * side * r * 0.5;
        const cy = head.y + ey * r * 0.36 + ex * side * r * 0.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx + ex * r * 0.16, cy + ey * r * 0.16, r * 0.2, 0, Math.PI * 2);
        ctx.fillStyle = "#101318";
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [bands, boosting]);
  return <canvas ref={ref} className="h-16 w-full" aria-hidden="true" />;
}
