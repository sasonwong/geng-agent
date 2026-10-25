FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

RUN npm i -g @earendil-works/pi-coding-agent

ENV HOME=/home/agent
RUN mkdir -p /home/agent/.pi/agent/sessions \
  && pi install npm:pi-observational-memory \
  && chmod -R 0777 /home/agent
# shortcut: /home/agent is world-writable so a non-root uid can write sessions.
# The agent can therefore rewrite its own extensions; when that matters, split the
# npm/ directory onto a read-only mount.

WORKDIR /work
ENTRYPOINT []
CMD ["pi", "--help"]
