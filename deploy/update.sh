#!/usr/bin/env bash
# Pull the program, rebuild the image, restart whatever is running it.
#
# The image is what carries its tools, and every waking starts a fresh container
# from `geng-agent:latest` — so rebuilding is the whole update. Nothing restarts
# the running agent mid-cycle: the daemon picks the new image up on its next waking,
# and the wake paper says the environment changed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

git pull --ff-only
"$ROOT/deploy/build.sh"

# restart daemons and the gateway if they are installed; a fresh clone has neither
systemctl --user restart --all 'geng@*' 2>/dev/null || true
systemctl --user restart geng-gateway 2>/dev/null || true

echo "更新完成：镜像 $(git rev-parse --short HEAD) 起的那份代码。"
echo "下一次醒来会读到『环境变了』。"
