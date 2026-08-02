# Docker container example

This example uses `docker exec` to open a PTY inside explicitly allowed test
containers.

> [!CAUTION]
> Access to the Docker daemon is effectively host-root access. This server has
> no authentication and binds to `127.0.0.1` by default. Use it only as a local
> demonstration, never as an internet-facing terminal service. Browser
> WebSockets are restricted to exact local origins by default.

## Prerequisites

- Node.js 22.13 or newer in the Node 22 line, or Node.js 24+
- Docker Engine and permission to use its socket
- A C/C++ toolchain supported by `node-pty`

## Local setup

```bash
npm ci --prefix ../..
npm run deps:build --prefix ../..
npm run build --prefix ../..
npm ci
npm run deps:build
docker run --detach --name test-container alpine:3.23.5 sleep infinity
npm start
```

Open <http://127.0.0.1:3000>, select `test-container`, and start a session.
The browser assets come from the local build rather than a third-party CDN.

The server accepts only container names matching `test-*`, uses `/bin/sh`,
keeps verbose logging off, enforces short session/count limits, and disables
local host-shell sessions. Disabling local execution is essential here: a local
shell could otherwise invoke the shipped Docker CLI through the mounted socket
and bypass the container-name allowlist.

## Compose demo

From the repository root on Linux, pass the Docker socket's group ID so the
non-root application user can reach it:

```bash
export DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
docker compose --file docker/docker-compose.yml up --build
```

The Compose stack:

- publishes the demo on loopback only;
- restricts browser WebSockets to the published local origins;
- runs the terminal process and test containers as non-root users;
- drops Linux capabilities and enables `no-new-privileges`;
- uses read-only root filesystems with bounded temporary filesystems;
- pins current stable Node, Alpine, Ubuntu LTS, and Docker CLI release lines;
- waits for test-container health checks and includes an application health
  check.

These controls reduce accidental exposure, but they do not make mounting the
Docker socket safe for untrusted users.

## Configuration

| Variable                    | Default             | Purpose                                             |
| --------------------------- | ------------------- | --------------------------------------------------- |
| `HOST`                      | `127.0.0.1`         | Listen address; the image sets `0.0.0.0` internally |
| `PORT`                      | `3000`              | HTTP and WebSocket port                             |
| `LIT_SHELL_ALLOWED_ORIGINS` | Exact local origins | Comma-separated canonical HTTP(S) browser origins   |
| `LIT_SHELL_VERBOSE`         | `false`             | Enable diagnostic server logging                    |

Compose derives its default allowed origins from `LIT_SHELL_PORT`. For another
hostname or reverse proxy, set `LIT_SHELL_ALLOWED_ORIGINS` explicitly. Origin
checks do not replace authentication for non-browser clients.

Check readiness with:

```bash
curl --fail http://127.0.0.1:3000/healthz
```

## Test and audit

```bash
npm test
npm audit --omit=dev
```

Remove the local test container when finished:

```bash
docker rm --force test-container
```
