#!/usr/bin/env bash
# Pull the program, reinstall the units, rebuild every image in use, restart what is on.
#
# The image carries pi and the toolchain; the tools themselves are mounted from the
# checkout, so an edit to one needs no rebuild. Every waking still starts a fresh
# container from the image its policy names, so a Dockerfile change lands on the next
# waking, and the wake paper says the environment changed. Nothing restarts the running
# agent mid-cycle.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

# `git pull --ff-only` on a dirty tree or a detached HEAD can succeed while leaving the
# running code neither at the pulled commit nor at what it was. Say so before touching
# anything, not after the image has already been rebuilt.
if [ -n "$(git status --porcelain)" ]; then
  echo "工作区不干净：先把本地改动提交或 stash，再升级。" >&2
  exit 1
fi
if ! git symbolic-ref --quiet --short HEAD >/dev/null; then
  echo "HEAD 是 detached：先切回一个分支再升级。" >&2
  exit 1
fi

git pull --ff-only

# A unit template is an *input* to the installed unit, not the unit itself. §4 copies it
# once into ~/.config/systemd/user; if an upgrade changes KillMode, RuntimeDirectory or
# ExecStart, a script that only restarts will run the old file forever. Reinstall all
# three on every update and make systemd re-read them before any restart.
NODE="$(command -v node)" || { echo "找不到 node" >&2; exit 1; }
mkdir -p "$UNIT_DIR"
# sed treats \&| specially on the replacement side; a checkout path or a node path can
# contain any of them. Escape before substituting.
escape_sed() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }
ROOT_ESC="$(escape_sed "$ROOT")"
NODE_ESC="$(escape_sed "$NODE")"
for unit in 'geng@.service' geng-gateway.service geng-search.service; do
  sed -e "s|@ROOT@|$ROOT_ESC|g" -e "s|@NODE@|$NODE_ESC|g" \
    "$ROOT/deploy/$unit" > "$UNIT_DIR/$unit"
done
systemctl --user daemon-reload

# Each instance remembers which image it uses (`init --image` writes it into
# data/<inst>/policy.json). Building only `geng-agent:latest` leaves a custom-tag
# instance on the old image forever — and the wake paper never says "环境变了".
mapfile -t images < <(
  {
    if [ -n "${GENG_IMAGE:-}" ]; then printf '%s\n' "$GENG_IMAGE"; fi
    "$NODE" -e '
      const fs = require("fs"), path = require("path");
      const data = process.argv[1];
      if (!fs.existsSync(data)) process.exit(0);
      for (const name of fs.readdirSync(data)) {
        try {
          const policy = JSON.parse(fs.readFileSync(path.join(data, name, "policy.json"), "utf8"));
          if (typeof policy?.container?.image === "string" && policy.container.image.trim()) {
            console.log(policy.container.image.trim());
          }
        } catch { /* 坏 policy 是 doctor 要报的事，不是升级脚本该猜的 */ }
      }
    ' "$ROOT/data"
  } | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | grep -v '^$' | sort -u || true
)
if [ "${#images[@]}" -eq 0 ]; then images=(geng-agent:latest); fi
for image in "${images[@]}"; do
  echo "重建镜像 $image"
  GENG_IMAGE="$image" "$ROOT/deploy/build.sh"
done

# Which units are enabled is a fact about systemd, not about this checkout. §4 leaves
# gateway and search disabled until §5, so "not enabled" is a normal state and not a
# restart to attempt. `--runtime` enables and some systemd versions do not list wants
# symlinks in list-unit-files, so both sources go into the set.
enabled_units() {
  systemctl --user list-unit-files --state=enabled --no-legend --plain 2>/dev/null | awk '{print $1}'
  for link in "$UNIT_DIR"/default.target.wants/geng@*.service \
              "$UNIT_DIR"/default.target.wants/geng-gateway.service \
              "$UNIT_DIR"/default.target.wants/geng-search.service; do
    [ -e "$link" ] || continue
    basename "$link"
  done
}
mapfile -t units < <(
  enabled_units | grep -E '^geng@.+\.service$|^geng-(gateway|search)\.service$' \
    | grep -v '^geng@\.service$' | sort -u || true
)

if [ "${#units[@]}" -eq 0 ]; then
  echo "没有已启用的 geng unit：全新 clone 就是这个形状，不是跳过检查。"
else
  for unit in "${units[@]}"; do
    echo "重启 $unit"
    # No `2>/dev/null || true`: a restart that fails is an upgrade that failed. It used
    # to print "更新完成" either way, which is the one answer this script must not give.
    systemctl --user restart "$unit"
  done
fi

echo "更新完成：$(git rev-parse --short HEAD)，重建了 ${#images[@]} 个镜像，重启了 ${#units[@]} 个 unit。"
echo "下一次醒来：镜像换过就会读到『环境变了』；只改了 daemon 或 image/extensions/ 里的工具则不会。"
