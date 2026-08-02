# syntax=docker/dockerfile:1.10@sha256:865e5dd094beca432e8c0a1d5e1c465db5f998dca4e439981029b3b81fb39ed5

ARG NODE_IMAGE=node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7

FROM ${NODE_IMAGE} AS native-build

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      build-essential \
      libseccomp-dev \
      python3 \
    && rm -rf /var/lib/apt/lists/*

COPY deploy/remote-shell /build/deploy/remote-shell

RUN mkdir /out /rootfs \
    && sh /build/deploy/remote-shell/build-launcher.sh \
      /out/lit-shell-sandbox \
    && sh /build/deploy/remote-shell/build-rootfs.sh /rootfs

FROM ${NODE_IMAGE} AS node-build

ARG NPM_VERSION=11.19.0

WORKDIR /app

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm install --global "npm@${NPM_VERSION}" \
    && npm ci --ignore-scripts \
    && npm rebuild \
      --ignore-scripts=false \
      --strict-allow-scripts=true \
      esbuild node-pty

COPY deploy/remote-shell ./deploy/remote-shell
COPY src ./src
RUN mkdir /out \
    && npx esbuild deploy/remote-shell/server.ts \
      --bundle \
      --format=esm \
      --outfile=/out/remote-shell-server.mjs \
      --packages=external \
      --platform=node \
      --target=node24

FROM ${NODE_IMAGE} AS production-dependencies

ARG NPM_VERSION=11.19.0

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --global "npm@${NPM_VERSION}" \
    && npm ci --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS runtime

ENV HOST=0.0.0.0 \
    NODE_ENV=production \
    PORT=10000

WORKDIR /app

RUN apt-get update \
    && apt-get install --yes --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 65531 gateway \
    && useradd \
      --no-create-home \
      --no-user-group \
      --shell /usr/sbin/nologin \
      --uid 65531 \
      --gid 65531 \
      gateway

COPY --from=native-build /rootfs /srv/lit-shell-rootfs
COPY --from=native-build /out/lit-shell-sandbox /usr/local/bin/lit-shell-sandbox
COPY --from=node-build /out/remote-shell-server.mjs ./remote-shell-server.mjs
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=node-build /app/node_modules/node-pty ./node_modules/node-pty
COPY --from=node-build /app/node_modules/node-addon-api ./node_modules/node-addon-api

RUN chown root:root /usr/local/bin/lit-shell-sandbox \
    && chmod 4755 /usr/local/bin/lit-shell-sandbox \
    && chown -R root:root /app /srv/lit-shell-rootfs \
    && chmod 0555 /app /app/remote-shell-server.mjs /srv/lit-shell-rootfs

USER 65531:65531

EXPOSE 10000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "const p=process.env.PORT||10000;fetch('http://127.0.0.1:'+p+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/remote-shell-server.mjs"]
