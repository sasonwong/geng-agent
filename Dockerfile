# Two stages. The first has npm, which is the only way to install pi packages; the
# second has no node at all — pi ships a standalone binary, and the container is the one
# place where "one less runtime" is worth a build stage.
FROM node:24-slim AS packages
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm config set registry "$NPM_REGISTRY" \
  && npm config set fetch-retries 5 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm i -g --fetch-retries=5 --fetch-retry-maxtimeout=120000 @earendil-works/pi-coding-agent
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
# again after every sleep is a tool that can also be replaced. Pin the version.
ARG GH_VERSION=2.103.2
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  curl -fsSL -o /tmp/gh.tgz \
    "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
  tar -xzf /tmp/gh.tgz -C /tmp; \
  install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh; \
  rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_${arch}"; \
  gh --version

# `git clone`/`push` authenticate by asking the daemon for an installation token over the
# book socket. The agent never holds a long-lived credential, and the shell script cannot
# read anything else on the host: the socket only answers this one question.
RUN cat > /usr/local/bin/geng-gh-credential <<'SH'
#!/bin/sh
# git calls this with `get`/`store`/`erase`; only `get` has an answer, and it comes from
# the host. No socket or no app means no credential — the clone then fails as an auth
# error, which is the truth.
[ "$1" = "get" ] || exit 0
token=$(curl -fsS --unix-socket "${GENG_BOOK_SOCK:-/run/geng/book.sock}" http://localhost/gh/token 2>/dev/null) || exit 0
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
ARG PI_VERSION=1.5.0
ARG PI_SHA256=""
RUN set -eux; \
  case "$(dpkg --print-architecture)" in arm64) arch=arm64 ;; *) arch=x64 ;; esac; \
  curl -fsSL -o /tmp/pi.tgz \
    "https://github.com/earendil-works/pi/releases/download/v${PI_VERSION}/pi-linux-${arch}.tar.gz"; \
  if [ -n "$PI_SHA256" ]; then echo "$PI_SHA256  /tmp/pi.tgz" | sha256sum -c -; fi; \
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
[ -d "$HOME/.pi/agent/npm" ] || cp -r /opt/pi-npm "$HOME/.pi/agent/npm"
# The container has no network. These two listeners are how anything gets out at all: one
# carries model requests, the other is the HTTP proxy every tool is pointed at. Both are
# loopback, both end at the book socket, and neither holds a credential.
socat TCP-LISTEN:11434,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/geng/book.sock &
socat TCP-LISTEN:3128,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/geng/book.sock &
# the port is open before the first request, but give socat a moment to fail loudly if the
# socket is missing: a broken pipe here is better than a mystery "connection refused"
sleep 0.2
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
