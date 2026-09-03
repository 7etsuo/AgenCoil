# AgenCoil

Multiplayer slither.io-style arena. Steer with the mouse or WASD, hold to boost, eat orbs, grow, don't hit anyone.

## Play

```bash
npm install
npm run dev
```

Open the app, pick a skin, hit Play. Everyone lands in the same arena, which is always populated by bots, and other players link in over WebRTC as they arrive.

Controls: mouse or WASD to steer, hold click, space or shift to boost, scroll to zoom. On touch screens drag to steer and hold the lightning button to boost.

Rules: orbs near your head get pulled in. Boosting is twice as fast but sheds length behind you as a pellet trail. Your head touching any other body pops you, and both snakes die on a head-on hit. A dead snake turns into glowing remains worth most of its length. The rim kills without leaving anything. Golden chase orbs flee from heads and are worth the most.

## Stack

Canvas 2D arena, path-history snakes drawn as shaded segments, P2P WebRTC mesh for other players, bots run by whichever linked client is the host.
