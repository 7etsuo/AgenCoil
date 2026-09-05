/**
 * Vercel Function entry. Exporting an http.Server lets Vercel upgrade
 * WebSocket connections on /api/ws; plain GETs return the arena status.
 */
import http from "node:http";
import { GameServer, guardProcess } from "./game-server";

guardProcess();
const server = http.createServer();
const game = new GameServer();
game.attach(server);

export default server;
