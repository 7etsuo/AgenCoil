#!/usr/bin/env python3
"""Write a checkpoint's weights as JSON for the browser driver (rl/drive.ts)."""
import json
import sys

import torch

ck = torch.load(sys.argv[1], map_location="cpu")
st = ck["state"]
layers = []
for name in ("body.0", "body.2", "pi"):
    layers.append({"w": st[f"{name}.weight"].tolist(), "b": st[f"{name}.bias"].tolist()})
json.dump({"obs_dim": ck["obs_dim"], "n_actions": ck["n_actions"], "layers": layers}, open(sys.argv[2], "w"))
print("wrote", sys.argv[2])
