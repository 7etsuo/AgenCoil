/**
 * A small GIF89a encoder: fixed 6x6x6 colour cube plus greys, LZW per frame.
 * Enough to turn a few dozen small replay frames into a shareable loop.
 */

const CUBE = 6;
const GREYS = 32;
const PALETTE: number[] = [];
for (let r = 0; r < CUBE; r++)
  for (let g = 0; g < CUBE; g++)
    for (let b = 0; b < CUBE; b++)
      PALETTE.push(
        Math.round((r * 255) / (CUBE - 1)),
        Math.round((g * 255) / (CUBE - 1)),
        Math.round((b * 255) / (CUBE - 1)),
      );
for (let i = 0; i < GREYS; i++) {
  const v = Math.round((i * 255) / (GREYS - 1));
  PALETTE.push(v, v, v);
}
while (PALETTE.length < 256 * 3) PALETTE.push(0);

function indexOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 18) return CUBE * CUBE * CUBE + Math.round((max / 255) * (GREYS - 1));
  const q = (v: number) => Math.round((v / 255) * (CUBE - 1));
  return q(r) * CUBE * CUBE + q(g) * CUBE + q(b);
}

class ByteSink {
  private buf = new Uint8Array(1 << 16);
  private n = 0;
  byte(v: number): void {
    if (this.n >= this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.n++] = v & 0xff;
  }
  short(v: number): void {
    this.byte(v);
    this.byte(v >> 8);
  }
  bytes(a: ArrayLike<number>): void {
    for (let i = 0; i < a.length; i++) this.byte(a[i]!);
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

/** LZW-compress indices (8-bit codes) into GIF sub-blocks. */
function lzw(indices: Uint8Array, out: ByteSink): void {
  const minCode = 8;
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let codeSize = minCode + 1;
  let next = eoi + 1;
  let dict = new Map<number, number>();
  const chunk: number[] = [];
  let bitBuf = 0;
  let bitCnt = 0;
  const emit = (code: number) => {
    bitBuf |= code << bitCnt;
    bitCnt += codeSize;
    while (bitCnt >= 8) {
      chunk.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCnt -= 8;
      if (chunk.length === 255) {
        out.byte(255);
        out.bytes(chunk);
        chunk.length = 0;
      }
    }
  };
  out.byte(minCode);
  emit(clear);
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      dict = new Map();
      next = eoi + 1;
      codeSize = minCode + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bitCnt > 0) chunk.push(bitBuf & 0xff);
  if (chunk.length) {
    out.byte(chunk.length);
    out.bytes(chunk);
  }
  out.byte(0);
}

/** Encode RGBA frames of one size into an animated GIF; delay in ms per frame. */
export function encodeGif(frames: ImageData[], delayMs: number): Uint8Array {
  const w = frames[0]!.width;
  const h = frames[0]!.height;
  const out = new ByteSink();
  out.bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  out.short(w);
  out.short(h);
  out.byte(0xf7); // global colour table, 256 entries
  out.byte(0);
  out.byte(0);
  out.bytes(PALETTE);
  // Netscape loop extension.
  out.bytes([0x21, 0xff, 0x0b]);
  out.bytes([0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30]);
  out.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);
  const delay = Math.max(2, Math.round(delayMs / 10));
  for (const f of frames) {
    out.bytes([0x21, 0xf9, 0x04, 0x00]);
    out.short(delay);
    out.byte(0);
    out.byte(0);
    out.byte(0x2c);
    out.short(0);
    out.short(0);
    out.short(w);
    out.short(h);
    out.byte(0);
    const idx = new Uint8Array(w * h);
    const d = f.data;
    for (let i = 0, j = 0; i < idx.length; i++, j += 4)
      idx[i] = indexOf(d[j]!, d[j + 1]!, d[j + 2]!);
    lzw(idx, out);
  }
  out.byte(0x3b);
  return out.finish();
}
