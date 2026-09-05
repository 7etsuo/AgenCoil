#!/usr/bin/env python3
"""Read an eval JSON from rl/train.py --eval and say what the learner does, and what that means for the game."""
import json
import sys
from collections import Counter

import numpy as np

path = sys.argv[1]
data = json.load(open(path))
lives = data["lives"]
cut = [l for l in lives if l["cause"] == "reset"]
lives = [l for l in lives if l["cause"] != "reset"]
ag = [l for l in lives if l["agent"]]
bt = [l for l in lives if not l["agent"]]
if cut:
    print(f"{len(cut)} learner lives were still going when their arena reset (not counted as deaths): "
          f"mean {np.mean([l['secs'] for l in cut]):.0f}s, peak {np.mean([l['maxMass'] for l in cut]):.0f}")


def pct(xs, ps=(10, 50, 90)):
    a = np.array(xs)
    return " ".join(f"p{p} {np.percentile(a, p):.0f}" for p in ps)


def block(name, ls):
    if not ls:
        return
    secs = [l["secs"] for l in ls]
    mass = [l["mass"] for l in ls]
    peak = [l["maxMass"] for l in ls]
    print(f"\n{name}: {len(ls)} lives")
    print(f"  life secs   {pct(secs)}  mean {np.mean(secs):.0f}")
    print(f"  final mass  {pct(mass)}  mean {np.mean(mass):.0f}")
    print(f"  peak mass   {pct(peak)}  max {max(peak):.0f}")
    print(f"  kills/life  {np.mean([l['kills'] for l in ls]):.2f}")
    causes = Counter(l["cause"] for l in ls)
    print("  deaths      " + ", ".join(f"{k} {100*v/len(ls):.0f}%" for k, v in causes.most_common()))
    early = [l for l in ls if l["secs"] < 5]
    if early:
        ec = Counter(l["cause"] for l in early)
        print(f"  dead inside 5 s: {100*len(early)/len(ls):.0f}% (" + ", ".join(f"{k} {v}" for k, v in ec.most_common()) + ")")
    growth = [l["maxMass"] / max(1, l["secs"]) for l in ls if l["secs"] >= 30]
    if growth:
        print(f"  growth (peak mass per second, lives over 30 s): {pct(growth)}")
    radii = [l["deathRadius"] for l in ls if "deathRadius" in l]
    if radii:
        r = np.array(radii)
        print(
            f"  where they died: inner half {100*np.mean(r < 0.5):.0f}%, outer half {100*np.mean((r >= 0.5) & (r < 0.85)):.0f}%,"
            f" rim band {100*np.mean(r >= 0.85):.0f}%"
        )
    ratios = [l["killerMass"] / max(1, l["mass"]) for l in ls if l.get("killerMass", 0) > 0]
    if ratios:
        r = np.array(ratios)
        print(
            f"  killer's size against the victim's: smaller {100*np.mean(r < 0.8):.0f}%, similar {100*np.mean((r >= 0.8) & (r <= 1.25)):.0f}%,"
            f" bigger {100*np.mean((r > 1.25) & (r <= 4)):.0f}%, four times or more {100*np.mean(r > 4):.0f}%"
        )


block("learner", ag)
block("bots", bt)
if ag and "arenaSecs" in ag[0]:
    print("\nlearner by arena age at death")
    for lo, hi in ((0, 300), (300, 600), (600, 1200), (1200, 1e9)):
        sub = [l for l in ag if lo <= l["arenaSecs"] < hi]
        if not sub:
            continue
        causes = Counter(l["cause"] for l in sub)
        print(
            f"  {lo/60:.0f}-{min(hi, 3600)/60:.0f} min: {len(sub)} lives, life {np.mean([l['secs'] for l in sub]):.0f}s,"
            f" peak {np.mean([l['maxMass'] for l in sub]):.0f}, rim {100*np.mean([l['rimFrac'] for l in sub]):.0f}%, "
            + ", ".join(f"{k} {100*v/len(sub):.0f}%" for k, v in causes.most_common(3))
        )

if ag:
    print("\nlearner habits")
    print(f"  boosting {100*np.mean([l['boostFrac'] for l in ag]):.0f}% of the time")
    print(f"  within 900 units of the rim {100*np.mean([l['rimFrac'] for l in ag]):.0f}% of the time")
    tot_r = sum(l["remains"] for l in ag)
    tot_f = sum(l["food"] for l in ag)
    print(f"  intake: remains {100*tot_r/max(1e-9, tot_r+tot_f):.0f}%, natural food {100*tot_f/max(1e-9, tot_r+tot_f):.0f}%")
    print(f"  near misses per life {np.mean([l['nears'] for l in ag]):.2f}")
    # Does hugging the rim pay? Compare lives by rim fraction.
    hug = [l for l in ag if l["rimFrac"] > 0.5]
    mid = [l for l in ag if l["rimFrac"] <= 0.5]
    if hug and mid:
        print(
            f"  rim huggers ({len(hug)} lives, >50% at the rim): life {np.mean([l['secs'] for l in hug]):.0f}s peak {np.mean([l['maxMass'] for l in hug]):.0f}"
            f"  vs the rest ({len(mid)}): life {np.mean([l['secs'] for l in mid]):.0f}s peak {np.mean([l['maxMass'] for l in mid]):.0f}"
        )
    boosters = [l for l in ag if l["boostFrac"] > 0.3]
    calm = [l for l in ag if l["boostFrac"] <= 0.3]
    if boosters and calm:
        print(
            f"  heavy boosters ({len(boosters)} lives, >30% boosting): life {np.mean([l['secs'] for l in boosters]):.0f}s kills {np.mean([l['kills'] for l in boosters]):.2f}"
            f"  vs the rest ({len(calm)}): life {np.mean([l['secs'] for l in calm]):.0f}s kills {np.mean([l['kills'] for l in calm]):.2f}"
        )
    # Long lives: what did the best 10% do?
    top = sorted(ag, key=lambda l: l["maxMass"], reverse=True)[: max(1, len(ag) // 10)]
    print(
        f"  best 10% by peak ({len(top)} lives): peak {np.mean([l['maxMass'] for l in top]):.0f} life {np.mean([l['secs'] for l in top]):.0f}s"
        f" kills {np.mean([l['kills'] for l in top]):.2f} boost {100*np.mean([l['boostFrac'] for l in top]):.0f}% rim {100*np.mean([l['rimFrac'] for l in top]):.0f}%"
        f" remains {100*sum(l['remains'] for l in top)/max(1e-9, sum(l['remains']+l['food'] for l in top)):.0f}%"
    )
    if "actions" in data["report"]:
        acts = data["report"]["actions"]
        turns = ["-90", "-60", "-30", "-15", "0", "+15", "+30", "+60", "+90"]
        no = [float(acts.get(str(i), 0)) for i in range(9)]
        yes = [float(acts.get(str(i + 9), 0)) for i in range(9)]
        print("  turn choice (no boost / boost):")
        for t, a, b in zip(turns, no, yes):
            print(f"    {t:>4}  {100*a:5.1f}%  {100*b:5.1f}%")
