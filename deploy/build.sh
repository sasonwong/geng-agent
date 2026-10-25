#!/usr/bin/env bash
# Build the agent image.
#
# Docker needs a proxy here twice, in two different places:
#   - the daemon pulls base images through /etc/systemd/system/docker.service.d/proxy.conf
#   - build steps (apt, npm) run inside a container, so they need --network=host and
#     explicit build args: a proxy listening on 127.0.0.1 is invisible from a bridge
#
# Usage: DOCKER_BUILD_PROXY=http://127.0.0.1:3128 NPM_REGISTRY=https://registry.npmjs.org deploy/build.sh
#
# With no DOCKER_BUILD_PROXY the build runs with no proxy at all — that is the
# normal case on a VPS with direct internet. Never default to a local proxy: on a
# machine that does not run one, every apt and npm step inside the build hangs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROXY="${DOCKER_BUILD_PROXY:-}"
IMAGE="${GENG_IMAGE:-geng-agent:latest}"

ARGS=()
if [ -n "$PROXY" ]; then
  # a proxy on 127.0.0.1 is invisible from the build container's bridge network
  ARGS+=(
    --network=host
    --build-arg "HTTP_PROXY=$PROXY"
    --build-arg "HTTPS_PROXY=$PROXY"
    --build-arg "NO_PROXY=localhost,127.0.0.1,::1"
  )
fi
if [ -n "${NPM_REGISTRY:-}" ]; then
  ARGS+=(--build-arg "NPM_REGISTRY=$NPM_REGISTRY")
fi

exec docker build "${ARGS[@]}" -t "$IMAGE" "$ROOT"
