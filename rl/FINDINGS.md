# What a trained agent found in the arena

Two PPO runs on 2026-09-05 (see CLAUDE.md, "Training an agent"). The learner is
an ordinary player snake in the real world code, paid only for length gained,
kills and the length lost at death. Run one used a ten second horizon and
learned to eat fast and die fast. Run two used a hundred second horizon and
arenas that reset every ten game-minutes; it is the one measured below.
Numbers are from `rl/train.py --eval` over fresh arenas aging for ten minutes,
320 learners across 40 arenas of 50 bots, sampled actions.

## How it plays

| | learner | scripted bots, same worlds |
|---|---|---|
| median life | 228 s | 76 s |
| median peak length | 1,056 | 297 |
| longest life's peak | 7,631 | 6,575 |
| kills per life | 1.6 | 0.7 |
| boosting | 24% of the time | rarely |
| intake from remains | 40% (57% in its best lives) | not measured |
| time within 900 units of the rim | 2% | not measured |

It learned real play: it hunts in the interior, boosts to cut and to escape,
eats the remains of what dies, and lands two to three near misses a life.
Its best tenth of lives peak above 5,000. The scripted bots are far below it
on every line, which is fine: they are meant to be prey and scenery, and the
owner has asked that they stay scripted.

## Findings about the rules

1. Head-on collisions are half of a good player's deaths. 50% of the learner's
   deaths were head-ons (both heads die), 41% were running into a body, 9%
   the other learners. The bots die head-on 30% of the time. 42% of the
   learner's deaths came from a snake smaller than itself. A head-on is a coin
   flip that a small snake can force on a big one at no cost: it loses
   nothing and the big one drops up to 6,000 of remains for whoever is
   near. The wisp then lets the small snake bank 150 of that itself. This
   is the most exploitable rule in the game. Options: the bigger head wins a
   head-on; the head that strikes the other's side wins; or bots (whose
   cut-offs turn into head-ons when they are late) get a head-on avoidance
   rule. Any of these is a change from what the arena does today and is the
   owner's call.

2. The rim is not a refuge any more. Run two spent a phase (updates 100 to
   240) hugging the edge, with half of each life within 900 units of the rim,
   and living the full ten minutes at it, then abandoned it once it learned
   to hunt: 2% at the rim in the final policy, and 67% of its deaths in the
   inner half of the arena where it lives. The food regrowth change (orbs
   regrow where they were eaten) holds: the interior is where the value is.

3. A fresh arena is poor, an old one is rich. In an arena's first five
   minutes the learner's lives averaged 132 s and peaked at 668; in the next
   five, 384 s and 2,386. Bigger bots mean bigger remains. Every deploy
   rolls the arena and resets that economy, which players who were farming
   a mature arena will feel.

4. Boosting is worth it. Learner lives that boosted over 30% of the time
   lasted 395 s with 2.4 kills, against 194 s and 1.3 kills for the rest.
   The scripted bots almost never boost, so they are easier than a player
   who does.

5. Growth is steady, not explosive: the median learner gains 4 length a
   second over a life, the best tenth 10 to 12. A 100,000 run at that pace
   is hours of play; the owner's 121,208 day is skill above this agent's,
   which is what killing giants for 6,000 at a time looks like.

6. Nothing else broke. No spawn deaths (fewest lives under 5 s: 0% for the
   learner, 1% for bots), no wall-hugging, no exploit of spawn protection, no
   degenerate action (it uses every heading and boosts with turns).

## What was not measured

Contracts, bounties, the boss, modes and the wisp are server features
outside the world, so the learner never saw them. Other humans were not in
the worlds: the learner played against bots and copies of itself.

## Recordings

`node rl/watch.mjs rl/runs/second/latest.pt out.mp4 60` records the policy
driving the real client against an in-process arena. In its one-minute
recording it reached length 204 without dying.
