#!/usr/bin/env bash
# Deploy the Email Worker, from the machine that holds `wrangler login` — not from the
# agent host. The host runs the endpoint; the Worker is a Cloudflare object, and its
# credentials have no business sitting next to the instances.
#
# Nothing deployment-specific is stored in this directory:
#   wrangler.jsonc    the script itself (name, entry, compatibility date) — in git
#   ~/.config/.wrangler/config/default.toml   the OAuth token — outside the repo
#   .wrangler/, .dev.vars                     local scratch — gitignored
#   GENG_MAIL_URL / GENG_MAIL_TOKEN           Worker secrets, in Cloudflare only
#
# Usage: ./deploy.sh https://geng-mail.example.com
#        GENG_MAIL_TOKEN=… ./deploy.sh https://…
#
# The token must be the same string the receiving endpoint compares against. It is
# read from this clone's own secrets/mail.env when that exists (`~/geng-agent` on the
# machine that runs instances), otherwise from the environment — no second copy.
set -euo pipefail
cd "$(dirname "$0")"

URL="${1:-${GENG_MAIL_URL:-}}"
TOKEN="${GENG_MAIL_TOKEN:-}"

if [ -z "$URL" ]; then
  echo "用法：$0 https://收信端点的公网地址（就是 tunnel 上那个 hostname）" >&2
  exit 2
fi

# install first: a bare `npx wrangler` in a fresh clone would fetch some other
# version from the registry instead of the one the lock names
npm ci --silent

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "没有 wrangler 凭据：先在这个目录 npx wrangler login" >&2
  exit 2
fi

npx wrangler deploy

if [ -z "$TOKEN" ] && [ -f ../../secrets/mail.env ]; then
  # `|| true`: a file without that line makes grep exit 1, and under pipefail
  # `set -e` would kill the script before the message below
  TOKEN="$(grep -m1 '^GENG_MAIL_TOKEN=' ../../secrets/mail.env | cut -d= -f2- || true)"
fi
if [ -z "$TOKEN" ]; then
  echo "拿不到 token：export GENG_MAIL_TOKEN=…，或者让仓库根的 secrets/mail.env 里有它" >&2
  exit 2
fi

printf '%s' "$URL" | npx wrangler secret put GENG_MAIL_URL
printf '%s' "$TOKEN" | npx wrangler secret put GENG_MAIL_TOKEN

echo
npx wrangler secret list
echo
echo "端点是 $URL ：现在发一封真信，宿主上应该出现 mail ← … 一行"
