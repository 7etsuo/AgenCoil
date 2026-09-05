#!/usr/bin/env python3
"""PPO over the snek arena served by `node rl/run.mjs`.

Train:  python3 rl/train.py --run first --updates 400
Eval:   python3 rl/train.py --eval rl/runs/first/latest.pt --eval-steps 3000 [--greedy]

The environment is the game's own world; see rl/env.ts for what the learner
sees and is paid for. Every finished life (the learner's and the bots') comes
back with the numbers the analysis wants, and the log keeps them.
"""
import argparse
import json
import os
import socket
import struct
import time
from collections import Counter

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


class NodeEnv:
    """The arenas behind rl/server.ts, as one vectorised environment."""

    def __init__(self, port: int):
        self.sock = socket.create_connection(("127.0.0.1", port))
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.n = 0
        self.d = 0

    def _recv(self, n: int) -> bytes:
        chunks = []
        got = 0
        while got < n:
            c = self.sock.recv(min(1 << 20, n - got))
            if not c:
                raise ConnectionError("environment server closed")
            chunks.append(c)
            got += len(c)
        return b"".join(chunks)

    def _read(self):
        n, d, ln = struct.unpack("<III", self._recv(12))
        self.n, self.d = n, d
        obs = np.frombuffer(self._recv(n * d * 4), dtype=np.float32).reshape(n, d)
        rew = np.frombuffer(self._recv(n * 4), dtype=np.float32)
        done = np.frombuffer(self._recv(n), dtype=np.uint8)
        info = json.loads(self._recv(ln)) if ln else []
        return obs, rew, done, info

    def reset(self):
        self.sock.sendall(b"\x00" + struct.pack("<I", 0))
        return self._read()[0]

    def step(self, actions: np.ndarray):
        a = actions.astype(np.int8)
        self.sock.sendall(b"\x01" + struct.pack("<I", len(a)) + a.tobytes())
        return self._read()


class Policy(nn.Module):
    def __init__(self, obs_dim: int, n_actions: int, hidden: int = 256):
        super().__init__()
        self.body = nn.Sequential(
            nn.Linear(obs_dim, hidden), nn.Tanh(), nn.Linear(hidden, hidden), nn.Tanh()
        )
        self.pi = nn.Linear(hidden, n_actions)
        self.v = nn.Linear(hidden, 1)
        for m in self.modules():
            if isinstance(m, nn.Linear):
                nn.init.orthogonal_(m.weight, gain=np.sqrt(2))
                nn.init.zeros_(m.bias)
        nn.init.orthogonal_(self.pi.weight, gain=0.01)
        nn.init.orthogonal_(self.v.weight, gain=1.0)

    def forward(self, x):
        h = self.body(x)
        return self.pi(h), self.v(h).squeeze(-1)


def summarise(lives: list) -> dict:
    """The report for a batch of finished lives: the learner's and the bots' side by side."""
    out = {}
    for who in ("agent", "bot"):
        ls = [l for l in lives if l["agent"] == (who == "agent")]
        if not ls:
            continue
        secs = np.array([l["secs"] for l in ls])
        mass = np.array([l["mass"] for l in ls])
        causes = Counter(l["cause"] for l in ls)
        row = {
            "lives": len(ls),
            "secs_mean": float(secs.mean()),
            "secs_median": float(np.median(secs)),
            "mass_mean": float(mass.mean()),
            "mass_max": float(max(l["maxMass"] for l in ls)),
            "kills_per_life": float(np.mean([l["kills"] for l in ls])),
            "cause": {k: round(v / len(ls), 3) for k, v in causes.most_common()},
        }
        if who == "agent":
            row["boost_frac"] = float(np.mean([l["boostFrac"] for l in ls]))
            row["rim_frac"] = float(np.mean([l["rimFrac"] for l in ls]))
            row["remains_share"] = float(
                sum(l["remains"] for l in ls) / max(1e-9, sum(l["remains"] + l["food"] for l in ls))
            )
            row["nears_per_life"] = float(np.mean([l["nears"] for l in ls]))
        out[who] = row
    return out


def fmt(rep: dict) -> str:
    parts = []
    for who, r in rep.items():
        cause = " ".join(f"{k}:{int(v * 100)}%" for k, v in r["cause"].items())
        extra = ""
        if who == "agent":
            extra = (
                f" boost {r['boost_frac']:.2f} rim {r['rim_frac']:.2f}"
                f" remains {r['remains_share']:.2f} nears {r['nears_per_life']:.1f}"
            )
        parts.append(
            f"{who}: n={r['lives']} life {r['secs_mean']:.0f}s (med {r['secs_median']:.0f})"
            f" mass {r['mass_mean']:.0f} max {r['mass_max']:.0f} kills {r['kills_per_life']:.2f}"
            f" [{cause}]{extra}"
        )
    return " | ".join(parts)


def train(args):
    dev = torch.device(args.device)
    env = NodeEnv(args.port)
    obs = env.reset()
    n, d = env.n, env.d
    n_actions = args.actions
    policy = Policy(d, n_actions).to(dev)
    opt = torch.optim.Adam(policy.parameters(), lr=args.lr, eps=1e-5)
    run_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs", args.run)
    os.makedirs(run_dir, exist_ok=True)
    log = open(os.path.join(run_dir, "log.jsonl"), "a")
    T = args.steps
    obs_buf = torch.zeros((T, n, d), device=dev)
    act_buf = torch.zeros((T, n), dtype=torch.long, device=dev)
    logp_buf = torch.zeros((T, n), device=dev)
    rew_buf = torch.zeros((T, n), device=dev)
    done_buf = torch.zeros((T, n), device=dev)
    val_buf = torch.zeros((T, n), device=dev)
    obs_t = torch.as_tensor(obs, device=dev)
    lives = []
    t_start = time.time()
    steps_total = 0
    # Rewards are divided by a running scale of the discounted return, so a
    # long horizon (returns in the hundreds) does not swamp the value loss.
    ret_scale = 1.0
    for update in range(1, args.updates + 1):
        t0 = time.time()
        policy.eval()
        with torch.no_grad():
            for t in range(T):
                logits, value = policy(obs_t)
                dist = torch.distributions.Categorical(logits=logits)
                action = dist.sample()
                obs_buf[t] = obs_t
                act_buf[t] = action
                logp_buf[t] = dist.log_prob(action)
                val_buf[t] = value
                nobs, rew, done, ended = env.step(action.cpu().numpy())
                rew_buf[t] = torch.as_tensor(rew, device=dev) / ret_scale
                done_buf[t] = torch.as_tensor(done.astype(np.float32), device=dev)
                obs_t = torch.as_tensor(nobs, device=dev)
                lives.extend(ended)
            _, last_value = policy(obs_t)
        # Generalised advantage estimation, backwards through the rollout.
        adv = torch.zeros((T, n), device=dev)
        gae = torch.zeros(n, device=dev)
        for t in reversed(range(T)):
            next_v = last_value if t == T - 1 else val_buf[t + 1]
            not_done = 1.0 - done_buf[t]
            delta = rew_buf[t] + args.gamma * next_v * not_done - val_buf[t]
            gae = delta + args.gamma * args.lam * not_done * gae
            adv[t] = gae
        ret = adv + val_buf
        if args.scale_returns:
            ret_scale = max(1e-3, 0.99 * ret_scale + 0.01 * float((ret * ret_scale).std().item()))
        b_obs = obs_buf.reshape(T * n, d)
        b_act = act_buf.reshape(-1)
        b_logp = logp_buf.reshape(-1)
        b_adv = adv.reshape(-1)
        b_ret = ret.reshape(-1)
        b_adv = (b_adv - b_adv.mean()) / (b_adv.std() + 1e-8)
        policy.train()
        total = T * n
        stats = Counter()
        for _ in range(args.epochs):
            perm = torch.randperm(total, device=dev)
            for i in range(0, total, args.minibatch):
                idx = perm[i : i + args.minibatch]
                logits, value = policy(b_obs[idx])
                dist = torch.distributions.Categorical(logits=logits)
                logp = dist.log_prob(b_act[idx])
                ratio = torch.exp(logp - b_logp[idx])
                a = b_adv[idx]
                pg = -torch.min(ratio * a, torch.clamp(ratio, 1 - args.clip, 1 + args.clip) * a).mean()
                vl = F.mse_loss(value, b_ret[idx])
                ent = dist.entropy().mean()
                loss = pg + args.vf * vl - args.ent * ent
                opt.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(policy.parameters(), 0.5)
                opt.step()
                stats["pg"] += pg.item()
                stats["vl"] += vl.item()
                stats["ent"] += ent.item()
                stats["n"] += 1
        steps_total += total
        dt = time.time() - t0
        rep = summarise(lives)
        line = {
            "update": update,
            "steps": steps_total,
            "sps": int(total / dt),
            "reward_mean": float(rew_buf.mean().item() * ret_scale),
            "ret_scale": ret_scale,
            "entropy": stats["ent"] / max(1, stats["n"]),
            "value_loss": stats["vl"] / max(1, stats["n"]),
            "elapsed": int(time.time() - t_start),
            "report": rep,
        }
        log.write(json.dumps(line) + "\n")
        log.flush()
        print(
            f"[{update}] {steps_total/1e6:.2f}M steps {line['sps']} sps r/step {line['reward_mean']:+.4f}"
            f" ent {line['entropy']:.2f} | {fmt(rep)}",
            flush=True,
        )
        lives = []
        if update % args.save_every == 0 or update == args.updates:
            torch.save({"state": policy.state_dict(), "obs_dim": d, "n_actions": n_actions}, os.path.join(run_dir, "latest.pt"))
            torch.save({"state": policy.state_dict(), "obs_dim": d, "n_actions": n_actions}, os.path.join(run_dir, f"u{update}.pt"))


def evaluate(args):
    dev = torch.device(args.device)
    env = NodeEnv(args.port)
    policy = None
    if args.eval != "random":
        ck = torch.load(args.eval, map_location=dev)
        policy = Policy(ck["obs_dim"], ck["n_actions"]).to(dev)
        policy.load_state_dict(ck["state"])
        policy.eval()
    obs = torch.as_tensor(env.reset(), device=dev)
    lives = []
    actions = Counter()
    t0 = time.time()
    with torch.no_grad():
        for t in range(args.eval_steps):
            if policy is None:
                action = torch.randint(0, args.actions, (obs.shape[0],), device=dev)
            elif args.greedy:
                logits, _ = policy(obs)
                action = logits.argmax(-1)
            else:
                logits, _ = policy(obs)
                action = torch.distributions.Categorical(logits=logits).sample()
            for a in action.cpu().numpy().tolist():
                actions[int(a)] += 1
            nobs, _, _, ended = env.step(action.cpu().numpy())
            obs = torch.as_tensor(nobs, device=dev)
            lives.extend(ended)
    rep = summarise(lives)
    total = sum(actions.values())
    rep["actions"] = {str(k): round(v / total, 3) for k, v in sorted(actions.items())}
    rep["steps"] = args.eval_steps
    rep["agents"] = env.n
    rep["secs"] = round(time.time() - t0, 1)
    print(fmt({k: v for k, v in rep.items() if k in ("agent", "bot")}))
    print("actions:", rep["actions"])
    out = args.eval_out or (
        "rl/runs/random.eval.json" if args.eval == "random" else os.path.splitext(args.eval)[0] + ".eval.json"
    )
    with open(out, "w") as f:
        json.dump({"report": rep, "lives": lives}, f)
    print("wrote", out)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=5555)
    p.add_argument("--run", default="run")
    p.add_argument("--updates", type=int, default=200)
    p.add_argument("--steps", type=int, default=128)
    p.add_argument("--actions", type=int, default=18)
    p.add_argument("--lr", type=float, default=2.5e-4)
    p.add_argument("--gamma", type=float, default=0.99)
    p.add_argument("--lam", type=float, default=0.95)
    p.add_argument("--clip", type=float, default=0.2)
    p.add_argument("--ent", type=float, default=0.01)
    p.add_argument("--vf", type=float, default=0.5)
    p.add_argument("--epochs", type=int, default=4)
    p.add_argument("--minibatch", type=int, default=8192)
    p.add_argument("--save-every", type=int, default=10)
    p.add_argument("--device", default="cuda:0" if torch.cuda.is_available() else "cpu")
    p.add_argument("--eval", default="")
    p.add_argument("--eval-steps", type=int, default=2000)
    p.add_argument("--eval-out", default="")
    p.add_argument("--greedy", action="store_true")
    p.add_argument("--scale-returns", action="store_true")
    args = p.parse_args()
    if args.eval:
        evaluate(args)
    else:
        train(args)


if __name__ == "__main__":
    main()
