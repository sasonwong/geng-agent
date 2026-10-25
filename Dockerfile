FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

# registry/retry are build args because a flaky proxy is the normal case
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm config set registry "$NPM_REGISTRY" \
  && npm config set fetch-retries 5 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm i -g --fetch-retries=5 --fetch-retry-maxtimeout=120000 @earendil-works/pi-coding-agent

ENV HOME=/home/agent
RUN mkdir -p /home/agent/.pi/agent/sessions /home/agent/.pi/agent/extensions \
  && pi install npm:pi-observational-memory \
  && chmod -R 0777 /home/agent

# say / mute / web_search are baked in, not mounted: the agent must not be able to
# rewrite the tools it talks to people with.
COPY image/extensions/ /home/agent/.pi/agent/extensions/
RUN chmod -R a+r /home/agent/.pi/agent/extensions

WORKDIR /work
ENTRYPOINT []
CMD ["pi", "--help"]
