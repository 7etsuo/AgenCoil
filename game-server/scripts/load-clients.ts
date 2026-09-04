/**
 * Scripted players for load-test.mjs: connect, spawn, steer at 30 Hz with a
 * view that follows the snake, and respawn after each death. Bundled by
 * the load test; not meant to be run directly.
 */
import WebSocket from "ws";
import { C2S, Reader, S2C, Writer, readSnakeEntry, writeBands } from "../../src/game/protocol";

const port = Number(process.argv[2] ?? 8390);
const count = Number(process.argv[3] ?? 60);

function hello(name: string, key: string, respawn: boolean): Uint8Array {
  const w = new Writer()
    .u8(respawn ? C2S.SPAWN : C2S.HELLO)
    .str(name)
    .u8(0);
  writeBands(w, undefined);
  w.str("").str(key).u8(0).str("").u8(0).str("").u16(0).str("").str("");
  return w.finish();
}

function player(i: number): void {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?v=2`);
  ws.binaryType = "arraybuffer";
  const name = `load${i}`;
  const key = `load-key-${i}`;
  let nid = 0;
  let x = 0;
  let y = 0;
  let angle = Math.random() * Math.PI * 2;
  let seq = 0;
  let timer: NodeJS.Timeout | null = null;
  ws.on("open", () => {
    ws.send(new Writer().u8(C2S.IDENT).str(key).str(name).finish());
    ws.send(hello(name, key, false));
    timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      angle += (Math.random() - 0.5) * 0.3;
      seq = (seq % 65535) + 1;
      ws.send(
        new Writer()
          .u8(C2S.INPUT)
          .u16(seq)
          .angle(angle)
          .u8(Math.random() < 0.05 ? 1 : 0)
          .f32(x)
          .f32(y)
          .f32(900)
          .f32(600)
          .u8(25)
          .finish(),
      );
    }, 33);
  });
  ws.on("message", (data) => {
    const r = new Reader(new Uint8Array(data as ArrayBuffer));
    const type = r.u8();
    if (type === S2C.SPAWNED) {
      nid = r.u16();
      x = r.f32();
      y = r.f32();
    } else if (type === S2C.SNAP) {
      r.u32();
      r.u32();
      const n = r.u16();
      for (let k = 0; k < n; k++) {
        const e = readSnakeEntry(r);
        if (e.full) r.u8();
        if (e.nid === nid) {
          x = e.x;
          y = e.y;
        }
      }
    } else if (type === S2C.DEATH) {
      if (r.u16() === nid) setTimeout(() => ws.send(hello(name, key, true)), 800);
    }
  });
  ws.on("close", () => {
    if (timer) clearInterval(timer);
  });
  ws.on("error", () => undefined);
}

for (let i = 0; i < count; i++) setTimeout(() => player(i), i * 15);
