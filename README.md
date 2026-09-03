# AgenCoil

Multiplayer slither.io-style arena. Steer with the mouse or WASD, hold to boost, eat orbs, grow, don't hit anyone.

## Play

```bash
npm install
npm run dev
```

Open the app, pick a skin or build your own, hit Play. Everyone lands in the same arena on the authoritative server, which is always populated by bots. If the server cannot be reached the game falls back to an offline practice arena with the same bots.

Controls: mouse or WASD to steer, hold click, space or shift to boost, scroll to zoom. On touch screens drag to steer and hold the lightning button to boost.

Rules: orbs near your head get pulled in. Boosting is twice as fast but sheds length behind you as a pellet trail. Your head touching any other body pops you, and both snakes die on a head-on hit. A dead snake turns into glowing remains worth most of its length. The rim kills without leaving anything. Golden chase orbs flee from heads and are worth the most.

## Server

The arena runs in `game-server/`: a Node process that owns the world, runs the bots, judges every collision and streams each player only what is near their camera over a binary WebSocket protocol.

```bash
cd game-server
npm install
npm run dev            # ws://localhost:8090/api/ws
```

Point the client at it with `VITE_GAME_SERVER=ws://localhost:8090/api/ws npm run dev`. Without that variable the client uses the production server.

The production server is a Vercel project (`agencoil-server`, root directory `game-server`) served from `/api/ws`. `vercel deploy --prod` from the repo root ships it. `GAME_SECRET` signs resume tokens so a reconnect keeps your snake and length even when it lands on a different instance. `DATABASE_URL` is optional and persists the daily leaderboard.

## Stack

Canvas 2D client with prediction for your own snake and interpolation for everyone else, path-history snakes drawn as shaded segments, authoritative Node WebSocket server with the same simulation code, bots with personalities that flee, hunt and coil.
