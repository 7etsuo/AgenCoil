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

The production server is a Vercel project (`agencoil-server`, root directory `game-server`) served from `/api/ws`; its build writes a Build Output API bundle (`npm run build:vercel`). Both it and the frontend project (`agencoil`) are connected to this GitHub repo, so a push to `main` deploys them. `GAME_SECRET` signs resume tokens so a reconnect keeps your snake and length even when it lands on a different instance. `DATABASE_URL` (a Neon database from the Vercel Marketplace) persists the daily leaderboard.

The server also runs anywhere Node runs. `game-server/Dockerfile` and `fly.toml` are ready for Fly.io, which gives one always-on world with no connection cap:

```bash
fly launch --no-deploy --copy-config --name agencoil-server
fly secrets set GAME_SECRET=$(openssl rand -hex 32)
fly deploy
```

Then set `VITE_GAME_SERVER=wss://agencoil-server.fly.dev/api/ws` for the client, or change the default in `src/game/net.ts`.

Abuse controls live in the server: four connections per IP, twenty connects per minute, sixty messages per second, and a name filter. The Vercel project also carries a firewall rate limit on `/api/ws`.

### Human verification

Online spawning can be protected with Cloudflare Turnstile. Create a widget with the `play`
action and configure its allowed hostname, then set these variables on the matching deployments:

```text
# Frontend (public)
VITE_TURNSTILE_SITE_KEY=<site-key>

# Game server (private)
TURNSTILE_SECRET_KEY=<secret-key>
TURNSTILE_HOSTNAMES=snek.grok.me,agencoil.vercel.app
TURNSTILE_ACTION=play
```

When the secret is present, the server fails closed: the frontend exchanges the single-use
Turnstile response at `POST /api/play-ticket`, then includes the resulting short-lived,
IP-bound ticket in its WebSocket `HELLO`. A successful redemption permits respawns for 30
minutes and is carried across short reconnects by the signed resume token. Keep `GAME_SECRET`
stable across instances. Without `TURNSTILE_SECRET_KEY`, the play gate is disabled for local
development and existing test environments.

## Tests

```bash
npm run e2e
```

Boots a private server and dev server, then drives real browsers through the trail, shared world, reload resume, server-replacement hop, offline fallback, throttled phone frame rate, and server status. `e2e/world.test.mjs` checks the shared simulation rules (collisions, lag compensation, arena modes) and `e2e/rules.test.mjs` checks streaks, leagues, levels, the hourly mode clock and seasons without a browser.

## Stack

Canvas 2D client with prediction for your own snake and interpolation for everyone else, path-history snakes drawn as shaded segments, authoritative Node WebSocket server with the same simulation code, bots with personalities that flee, hunt and coil.
