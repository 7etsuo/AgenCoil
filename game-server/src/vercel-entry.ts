/**
 * Vercel Function entry. Exporting an http.Server lets Vercel upgrade
 * WebSocket connections on /api/ws; plain GETs return the arena status.
 */
import http from "node:http";
import { GameServer } from "./game-server";

const server = http.createServer();
const game = new GameServer();
game.attach(server);

export default server;
