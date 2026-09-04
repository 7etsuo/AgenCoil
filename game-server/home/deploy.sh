#!/bin/sh
# Update the home arenas to the current main: pull, rebuild, restart one at a
# time so the coordinator always has a healthy arena to place players on.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
git pull --ff-only
(cd game-server && npm run bundle)
for u in $(systemctl --user list-units --plain --no-legend 'agencoil-arena@*' | awk '{print $1}'); do
  systemctl --user restart "$u"
  sleep 8
done
