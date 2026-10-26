FROM node:24-slim

# tzdata is not in the slim base: without it TZ=Asia/Shanghai silently means UTC
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git iproute2 tzdata \
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

# `git clone`/`push` authenticate through gh, which reads GH_TOKEN from the injected
# environment. The agent's own HOME is thrown away every waking, so this has to be
# system-wide or it would have to be redone each cycle.
RUN printf '[credential "https://github.com"]\n\thelper = !/usr/local/bin/gh auth git-credential\n' >> /etc/gitconfig

# registry/retry are build args because a flaky proxy is the normal case
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm config set registry "$NPM_REGISTRY" \
  && npm config set fetch-retries 5 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm i -g --fetch-retries=5 --fetch-retry-maxtimeout=120000 @earendil-works/pi-coding-agent

# No memory extension on purpose: every waking is its own session, so there is nothing
# to compact and nothing to carry. Its memory is the palimpsest, not the context.
ENV HOME=/home/agent
RUN mkdir -p /home/agent/.pi/agent/sessions /home/agent/.pi/agent/extensions \
  && chmod -R 0777 /home/agent

# say / mute / web_search live outside the agent's home and are loaded with -e, so
# neither writing nor deleting them is possible: chmod on the files alone would not
# stop `rm -rf`, because the directory above them is writable.
COPY image/extensions/ /opt/geng/extensions/
RUN chown -R root:root /opt/geng/extensions && chmod -R 0555 /opt/geng/extensions

WORKDIR /work
ENTRYPOINT []
CMD ["pi", "--help"]
