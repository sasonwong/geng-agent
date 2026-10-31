#!/usr/bin/env bash
# Pull the program, rebuild the image, restart whatever is running it.
#
# The image carries pi and the toolchain; the tools themselves are mounted from the
# checkout, so an edit to one needs no rebuild. Every waking still starts a fresh
# container from `geng-agent:latest`, so a Dockerfile change lands on the next waking,
# and the wake paper says the environment changed. Nothing restarts the running agent
# mid-cycle.
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
