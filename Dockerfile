# Two stages. The first has npm, which is the only way to install pi packages; the
# second has no node at all — pi ships a standalone binary, and the container is the one
# place where "one less runtime" is worth a build stage.
FROM node:24-slim AS packages
# 这一层装的是「用 pi 装好的扩展包」，不是 pi 本体；但装出来的目录格式由 pi 的版本
# 决定，最终镜像里跑的是下面 PI_VERSION 那个二进制。两个版本漂移时，1.5.0 的 pi 会
# 读不懂一个更新版 pi 写下的 ~/.pi/agent/npm，而报错发生在第一次醒来，不是构建时。
# 两处 ARG 默认值必须一致（test/dockerfile.test.ts 钉着）。
ARG PI_VERSION=1.5.0
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm config set registry "$NPM_REGISTRY" \
  && npm config set fetch-retries 5 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm i -g --fetch-retries=5 --fetch-retry-maxtimeout=120000 "@earendil-works/pi-coding-agent@${PI_VERSION}"
ENV HOME=/home/agent
# Installed here, at build time: the running container has no network of its own, so
# anything fetched per waking would be fetched and then lost. The list has to match
# `deploy/settings.json` — that file is mounted over this image's copy at run time, and a
# package declared there but never installed makes pi exit on the first waking.
RUN pi install npm:@dietrichgebert/ponytail \
  && pi install npm:@ff-labs/pi-fff

FROM debian:bookworm-slim

# tzdata is not in the slim base: without it TZ=Asia/Shanghai silently means UTC
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git iproute2 socat tzdata \
  && rm -rf /var/lib/apt/lists/*

# gh is in the image rather than downloaded per waking: a tool that has to be fetched
# again after every sleep is a tool that can also be replaced. Pin the version *and*
# check the bytes: a `curl -fsSL` proves only that something answered, not that it was
# this release. The hashes live in deploy/checksums.txt, copied from each release's own
# checksum file and keyed by filename — an unknown arch or a version bump without a new
# line has no entry, so the build stops instead of guessing.
# awk 里的 `sub(/\r$/...)` 是为了 CRLF 的构建上下文：否则每一行末尾的 \r 会让
# 文件名永远匹配不上，报「清单里没有这个文件」，而其实文件就在那里。
COPY deploy/checksums.txt /tmp/geng-checksums.txt
ARG GH_VERSION=2.103.2
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  gh_file="gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
  gh_sha="$(awk -v f="$gh_file" '{ sub(/\r$/, "", $2); if ($2 == f) print $1 }' /tmp/geng-checksums.txt)"; \
  [ -n "$gh_sha" ] || { echo "checksums.txt 里没有 $gh_file，不要猜一个" >&2; exit 1; }; \
  curl -fsSL -o /tmp/gh.tgz \
    "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
  echo "$gh_sha  /tmp/gh.tgz" | sha256sum -c -; \
  tar -xzf /tmp/gh.tgz -C /tmp; \
  install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh; \
  rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_${arch}"; \
  gh --version | grep -q "gh version ${GH_VERSION}"

# `git clone`/`push` authenticate by asking the daemon for an installation token over the
# book socket. The agent never holds a long-lived credential, and the shell script cannot
# read anything else on the host: the socket only answers this one question.
RUN cat > /usr/local/bin/geng-gh-credential <<'SH'
#!/bin/sh
# git calls this with `get`/`store`/`erase`; only `get` has an answer, and it comes from
# the host. No socket or no app means no credential — the clone then fails as an auth
# error, which is the truth.
[ "$1" = "get" ] || exit 0
# A socket that accepted but never answers would otherwise hang git for the whole
# cycle. No answer is a clean auth error, which is the truth the comment above wants.
token=$(curl -fsS --connect-timeout 2 --max-time 5 \
  --unix-socket "${GENG_BOOK_SOCK:-/run/geng/book.sock}" \
  http://localhost/gh/token 2>/dev/null) || exit 0
[ -n "$token" ] || exit 0
printf 'username=x-access-token\npassword=%s\n' "$token"
SH
RUN chmod 0755 /usr/local/bin/geng-gh-credential \
  && printf '[credential "https://github.com"]\n\thelper = !/usr/local/bin/geng-gh-credential\n' >> /etc/gitconfig \
  # git does read the environment, but the system config is the one that survives a
  # `--noproxy` habit and a wrapper script that clears the environment
  && printf '[http]\n\tproxy = http://127.0.0.1:3128\n' >> /etc/gitconfig

# pi itself: a Bun-compiled release binary, pinned like gh. No node in the image, so
# there is no npm, no package manager and no second copy of a JS runtime to keep patched.
# 和上面 packages 那一层的 ARG 必须一致。旧写法把 PI_SHA256 默认成空字符串再
# `if [ -n ... ]`，等于默认根本不校验，却写着「pinned like gh」。
ARG PI_VERSION=1.5.0
RUN set -eux; \
  case "$(dpkg --print-architecture)" in \
    amd64) arch=x64 ;; \
    arm64) arch=arm64 ;; \
    *) echo "$(dpkg --print-architecture) 没有对应的 pi 二进制，不要拿 x64 凑" >&2; exit 1 ;; \
  esac; \
  pi_file="pi-linux-${arch}.tar.gz"; \
  pi_sha="$(awk -v f="$pi_file" '{ sub(/\r$/, "", $2); if ($2 == f) print $1 }' /tmp/geng-checksums.txt)"; \
  [ -n "$pi_sha" ] || { echo "checksums.txt 里没有 $pi_file" >&2; exit 1; }; \
  curl -fsSL -o /tmp/pi.tgz \
    "https://github.com/earendil-works/pi/releases/download/v${PI_VERSION}/pi-linux-${arch}.tar.gz"; \
  echo "$pi_sha  /tmp/pi.tgz" | sha256sum -c -; \
  mkdir -p /opt; \
  tar -xzf /tmp/pi.tgz -C /opt; \
  rm -f /tmp/pi.tgz; \
  ln -s /opt/pi/pi /usr/local/bin/pi; \
  pi --version

# No memory extension on purpose: every waking is its own session, so there is nothing
# to compact and nothing to carry. Its memory is the book, not the context.
ENV HOME=/home/agent
# Packages live outside the agent's home so the home can be a tmpfs: the root filesystem
# is read-only at run time, and the entrypoint copies these in at the start of a waking.
COPY --from=packages /home/agent/.pi/agent/npm /opt/pi-npm
RUN mkdir -p /home/agent/.pi/agent/sessions \
  && chmod -R a+rX /home/agent/.pi /opt/pi-npm \
  # pi writes trust.json and its lock next to settings.json, and the container runs as
  # an arbitrary uid: without a writable agent dir it exits on the first waking
  && chmod 0777 /home/agent/.pi/agent /home/agent/.pi/agent/sessions

# The root filesystem is mounted read-only, so the agent's home is a tmpfs and this is
# what fills it: pi loads packages from `~/.pi/agent/npm`, and a copy per waking is
# cheaper than a mount that would hide the rest of the home.
RUN cat > /usr/local/bin/geng-pi <<'SH'
#!/bin/sh
set -eu
# The root filesystem is read-only and the agent's home is a tmpfs. Without this copy
# pi cannot load the packages installed at build time, and exits on the first waking.
if [ ! -d "$HOME/.pi/agent/npm" ]; then
  mkdir -p "$HOME/.pi/agent"
  cp -r /opt/pi-npm "$HOME/.pi/agent/npm"
fi
[ -d "$HOME/.pi/agent/npm" ] || { echo "geng-pi: 包目录没准备好" >&2; exit 1; }

# The container has no network. These two listeners are how anything gets out at all:
# one carries model requests, the other is the HTTP proxy every tool is pointed at.
# Both end at the book socket. Use the same path the credential helper uses instead of
# a second, hardcoded one: GENG_BOOK_SOCK is what command.ts actually injected.
sock="${GENG_BOOK_SOCK:-/run/geng/book.sock}"
[ -S "$sock" ] || { echo "geng-pi: book socket 不在 $sock，这一轮出不去" >&2; exit 1; }
socat TCP-LISTEN:11434,bind=127.0.0.1,reuseaddr,fork "UNIX-CONNECT:$sock" & model_pid=$!
socat TCP-LISTEN:3128,bind=127.0.0.1,reuseaddr,fork "UNIX-CONNECT:$sock" & proxy_pid=$!
sleep 0.2
# A socat that could not bind is gone by now. Old script still exec'd pi, so the waking
# died later as a mysterious "connection refused" on the model call.
for p in "$model_pid" "$proxy_pid"; do
  kill -0 "$p" 2>/dev/null || { echo "geng-pi: 到 book socket 的桥没起来" >&2; exit 1; }
done
exec pi "$@"
SH
RUN chmod 0755 /usr/local/bin/geng-pi

# The tools in image/extensions/ are mounted read-only at run time (see internal/command.ts),
# not copied in: a tool that changes during development must not cost a rebuild of the apt and
# npm layers above it. The mountpoint lives outside the agent's home so that neither writing
# nor deleting them is possible.
RUN mkdir -p /opt/geng/extensions

WORKDIR /work
ENTRYPOINT []
CMD ["pi", "--help"]
