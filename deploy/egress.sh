#!/bin/sh
# Host-side egress rules for the geng instance containers.
# Requires the containers to join a dedicated bridge network, e.g.:
#     docker network create --driver bridge agent-net
# and the runner to pass `--network agent-net`.
#
# Verify from inside a container (both MUST time out):
#     docker run --rm --network agent-net curlimages/curl -m 3 -s 169.254.169.254
#     docker run --rm --network agent-net curlimages/curl -m 3 -s 10.0.0.1
set -eu

BRIDGE="${1:-agent-net}"

for cidr in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
  iptables -C DOCKER-USER -i "br-$(docker network inspect -f '{{.Id}}' "$BRIDGE" | cut -c1-12)" \
    -d "$cidr" -j DROP 2>/dev/null ||
  iptables -I DOCKER-USER 1 -i "br-$(docker network inspect -f '{{.Id}}' "$BRIDGE" | cut -c1-12)" \
    -d "$cidr" -j DROP
done

# Only 80/443 outbound
BR="br-$(docker network inspect -f '{{.Id}}' "$BRIDGE" | cut -c1-12)"
for port in 80 443; do
  iptables -C DOCKER-USER -i "$BR" -p tcp --dport "$port" -j RETURN 2>/dev/null ||
    iptables -I DOCKER-USER 1 -i "$BR" -p tcp --dport "$port" -j RETURN
done

for proto in tcp udp; do
  iptables -C DOCKER-USER -i "$BR" -p "$proto" --dport 53 -j RETURN 2>/dev/null ||
    iptables -I DOCKER-USER 1 -i "$BR" -p "$proto" --dport 53 -j RETURN
done

iptables -C DOCKER-USER -i "$BR" -p tcp -j DROP 2>/dev/null ||
  iptables -I DOCKER-USER 1 -i "$BR" -p tcp -j DROP

echo "applied egress rules on $BR"
echo "now verify from inside a container — both of these must time out:"
echo "  169.254.169.254   and   10.0.0.1"
