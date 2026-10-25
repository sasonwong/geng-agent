#!/usr/bin/env bash
# Build the agent image.
#
# Docker needs a proxy here twice, in two different places:
#   - the daemon pulls base images through /etc/systemd/system/docker.service.d/proxy.conf
#   - build steps (apt, npm) run inside a container, so they need --network=host and
#     explicit build args: a proxy listening on 127.0.0.1 is invisible from a bridge
#
# Usage: DOCKER_BUILD_PROXY=http://127.0.0.1:3128 NPM_REGISTRY=https://registry.npmjs.org deploy/build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROXY="${DOCKER_BUILD_PROXY:-http://127.0.0.1:3128}"
IMAGE="${GENG_IMAGE:-geng-agent:latest}"

ARGS=(
  --build-arg "HTTP_PROXY=$PROXY"
  --build-arg "HTTPS_PROXY=$PROXY"
  --build-arg "NO_PROXY=localhost,127.0.0.1,::1"
)
if [ -n "${NPM_REGISTRY:-}" ]; then
  ARGS+=(--build-arg "NPM_REGISTRY=$NPM_REGISTRY")
fi

exec docker build --network=host "${ARGS[@]}" -t "$IMAGE" "$ROOT"
