// Plain Node entry for local play and for any host that is not Vercel.
import http from "node:http";
import { GameServer } from "./src/game-server.ts";

const port = Number(process.env.PORT ?? 8090);
const server = http.createServer();
const game = new GameServer();
game.attach(server);
server.listen(port, "0.0.0.0", () => {
  console.log(`[agencoil-server] ws://localhost:${port}/api/ws instance=${game.instance}`);
});
