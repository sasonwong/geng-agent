#!/bin/sh
# Host-side egress rules for the geng instance containers.
#
# Rules are scoped by the bridge interface, so they apply to instances only and
# cannot touch other containers on the default bridge.
#
# Order matters and is the whole point of this script: private ranges are dropped
# before 80/443 are let through (otherwise the host's own TLS ports are reachable),
# and the catch-all DROP comes last (a catch-all inserted at position 1 blocks
# everything, including the exceptions above it).
set -eu

BRIDGE="${1:-agent-net}"

if ! docker network inspect "$BRIDGE" >/dev/null 2>&1; then
  echo "没有网络 $BRIDGE：先 docker network create --driver bridge $BRIDGE" >&2
  exit 1
fi

BR="br-$(docker network inspect -f '{{.Id}}' "$BRIDGE" | cut -c1-12)"

# append once; -C keeps a re-run from stacking duplicates
add() {
  iptables -C DOCKER-USER -i "$BR" "$@" 2>/dev/null || iptables -A DOCKER-USER -i "$BR" "$@"
}

# the cloud metadata service is the classic credential-theft path
add -d 169.254.0.0/16 -j DROP
for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
  add -d "$cidr" -j DROP
done

add -p tcp --dport 80 -j RETURN
add -p tcp --dport 443 -j RETURN
add -p tcp --dport 53 -j RETURN
add -p udp --dport 53 -j RETURN
add -p tcp -j DROP

echo "applied egress rules on $BR"
echo "verify from inside a container: 169.254.169.254 and 10.0.0.1 must time out,"
echo "https://opencode.ai must still answer."
