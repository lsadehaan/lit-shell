# syntax=docker/dockerfile:1.26.0@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

ARG NODE_IMAGE=node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7

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

FROM ${NODE_IMAGE} AS runtime

ENV HOST=0.0.0.0 \
    NODE_ENV=production \
    PORT=10000

WORKDIR /app

RUN apt-get update \
    && apt-get install --yes --no-install-recommends tini util-linux \
    && rm -rf /var/lib/apt/lists/* \
      /usr/local/lib/node_modules/corepack \
      /usr/local/lib/node_modules/npm \
      /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/corepack /usr/local/bin/npm \
      /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && groupadd --gid 65532 guest \
    && useradd \
      --no-create-home \
      --no-user-group \
      --shell /bin/sh \
      --uid 65532 \
      --gid 65532 \
      guest \
    && install -d -o root -g root -m 0755 \
      /tmp /var/tmp /run/lock /dev/shm /dev/mqueue /workspace \
    && install -d -o guest -g guest -m 0700 /workspace/shared/tmp \
    && chmod 0750 /usr/local/bin/node \
    && find / -xdev -type f -perm /6000 -exec chmod a-s {} +

COPY --from=node-build /out/remote-shell-server.mjs ./remote-shell-server.mjs
COPY --from=node-build /app/node_modules/ws ./node_modules/ws
COPY --from=node-build /app/node_modules/node-pty ./node_modules/node-pty
COPY --from=node-build /app/node_modules/node-addon-api ./node_modules/node-addon-api
COPY deploy/remote-shell/guest-shell.sh /usr/local/bin/lit-shell-guest

RUN chown -R root:root /app /usr/local/bin/lit-shell-guest \
    && chmod 0555 /app /app/remote-shell-server.mjs \
      /usr/local/bin/lit-shell-guest

USER 0:0

EXPOSE 10000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "const p=process.env.PORT||10000;fetch('http://127.0.0.1:'+p+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/bin/setpriv", "--clear-groups", "--no-new-privs", "--bounding-set=-all,+chown,+dac_override,+kill,+setgid,+setuid", "--inh-caps=-all", "--ambient-caps=-all", "node", "/app/remote-shell-server.mjs"]
