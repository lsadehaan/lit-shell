# syntax=docker/dockerfile:1.26.0@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

ARG NODE_IMAGE=node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7
ARG DOCKER_CLI_IMAGE=docker:29.7.0-cli@sha256:206ae9cc405101ab0cf97d4b515d21bf6aae961f98f7f9d8de6c111718fef335

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${NODE_IMAGE} AS build

ARG NPM_VERSION=11.19.0

WORKDIR /app

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm install --global "npm@${NPM_VERSION}" \
    && npm ci --ignore-scripts \
    && npm rebuild --ignore-scripts=false --strict-allow-scripts=true esbuild node-pty

COPY scripts ./scripts
COPY src ./src
COPY tsconfig.build.json tsconfig.json ./
RUN npm run build

FROM ${NODE_IMAGE} AS production-dependencies

ARG NPM_VERSION=11.19.0

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --global "npm@${NPM_VERSION}" \
    && npm ci --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS runtime

ENV HOST=0.0.0.0 \
    LIT_SHELL_VERBOSE=false \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app

RUN rm -rf /usr/local/lib/node_modules/corepack \
      /usr/local/lib/node_modules/npm \
      /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/corepack /usr/local/bin/npm \
      /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
# node-pty is an optional peer for browser/client-only consumers. The demo is a
# server, so copy the exact native module built in the pinned build stage.
COPY --from=build --chown=node:node /app/node_modules/node-pty ./node_modules/node-pty
COPY --from=build --chown=node:node /app/node_modules/node-addon-api ./node_modules/node-addon-api
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node \
    examples/docker-container/app.js \
    examples/docker-container/index.html \
    examples/docker-container/server.js \
    examples/docker-container/style.css \
    ./examples/docker-container/
COPY --chown=node:node examples/shared ./examples/shared

USER node

EXPOSE 3000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT||3000;fetch('http://127.0.0.1:'+port+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "examples/docker-container/server.js"]
