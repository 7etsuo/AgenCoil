import type { ReplayFrame } from "@/game/engine";
import type { Vec } from "@/game/model";

/** World units shown across the replay's width. */
const SPAN_UNITS = 900;

/** Draw one recorded frame, centred on `centre`, into a w by h canvas context. */
export function renderReplayFrame(
  ctx: CanvasRenderingContext2D,
  f: ReplayFrame,
  centre: Vec,
  w: number,
  h: number,
  dpr = 1,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#07090f";
  ctx.fillRect(0, 0, w, h);
  const scale = w / SPAN_UNITS;
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
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** Where the camera should sit for a frame: your head, else a fallback. */
export function replayCentre(f: ReplayFrame, fallback: Vec): Vec {
  return f.snakes.find((s) => s.me)?.pts.at(-1) ?? fallback;
}

/** Render the replay to an animated GIF blob (320 by 180, one frame per record). */
export async function replayToGif(frames: ReplayFrame[], at: Vec | null): Promise<Blob> {
  const { encodeGif } = await import("@/lib/gif");
  const w = 320;
  const h = 180;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const fallback = at ?? replayCentre(frames[frames.length - 1]!, { x: 0, y: 0 });
  let centre = { ...fallback };
  const images: ImageData[] = [];
  const step = Math.max(1, Math.floor(frames.length / 40));
  for (let i = 0; i < frames.length; i += step) {
    const f = frames[i]!;
    const want = replayCentre(f, fallback);
    centre =
      i === 0
        ? { ...want }
        : { x: centre.x + (want.x - centre.x) * 0.5, y: centre.y + (want.y - centre.y) * 0.5 };
    renderReplayFrame(ctx, f, centre, w, h, 1);
    images.push(ctx.getImageData(0, 0, w, h));
  }
  // Hold the last frame.
  for (let k = 0; k < 5; k++) images.push(images[images.length - 1]!);
  const dt =
    frames.length > 1
      ? ((frames[frames.length - 1]!.t - frames[0]!.t) / frames.length) * step
      : 100;
  return new Blob([encodeGif(images, dt) as unknown as BlobPart], { type: "image/gif" });
}
