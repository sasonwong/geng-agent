FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git iproute2 \
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

# say / mute / web_search live outside the agent's home and are loaded with -e, so
# neither writing nor deleting them is possible: chmod on the files alone would not
# stop `rm -rf`, because the directory above them is writable.
COPY image/extensions/ /opt/geng/extensions/
RUN chown -R root:root /opt/geng/extensions && chmod -R 0555 /opt/geng/extensions

WORKDIR /work
ENTRYPOINT []
CMD ["pi", "--help"]
