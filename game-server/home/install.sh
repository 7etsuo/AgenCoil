#!/bin/sh
# Install the user-level systemd units for N home arenas and the tunnel.
#   sh game-server/home/install.sh 2      # two arenas on 8091 and 8092
set -eu
N="${1:-1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.config/systemd/user" "$HOME/.config/agencoil"
cp "$HERE/agencoil-arena@.service" "$HERE/cloudflared.service" "$HOME/.config/systemd/user/"
[ -f "$HOME/.config/agencoil/arena.env" ] || { cp "$HERE/arena.env.example" "$HOME/.config/agencoil/arena.env"; chmod 600 "$HOME/.config/agencoil/arena.env"; echo "fill in $HOME/.config/agencoil/arena.env"; }
(cd "$HERE/.." && npm run bundle)
systemctl --user daemon-reload
i=1
while [ "$i" -le "$N" ]; do
  systemctl --user enable --now "agencoil-arena@$i"
  i=$((i + 1))
done
echo "arenas: $N (ports 8091..$((8090 + N)))"
echo "tunnel: after 'cloudflared tunnel login' and 'cloudflared tunnel create snek', write ~/.cloudflared/config.yml and run: systemctl --user enable --now cloudflared"
