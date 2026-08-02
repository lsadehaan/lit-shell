# Session multiplexing example

This example shows several browser clients sharing a terminal session, replaying
history, and leaving a session running for another client.

The page explicitly enables the component's `allow-join` attribute for this
collaboration demo. Normal component sessions remain private by default.

> [!WARNING]
> This is an unauthenticated local demo. It binds to `127.0.0.1` by default.
> Browser WebSockets are restricted to exact local origins by default.
> Put an authenticated reverse proxy in front of the WebSocket endpoint before
> adapting it for a shared environment.

## Prerequisites

- Node.js 22.13 or newer in the Node 22 line, or Node.js 24+
- A C/C++ toolchain supported by `node-pty`
- Docker only when explicitly enabling the optional container mode

## Install and run

Build the checkout, install the example's locked runtime dependencies, and
start the server:

```bash
npm ci --prefix ../..
npm run deps:build --prefix ../..
npm run build --prefix ../..
npm ci
npm run deps:build
npm start
```

Open <http://127.0.0.1:3000>. To try multiplexing:

1. Create a local shell in the first browser tab.
2. Generate some output.
3. Open the page in a second tab.
4. Select **Join Existing Session**, choose the session, and join it.
5. Close the first tab and continue from the second.

With the default Docker-disabled configuration, local sessions use `/bin/sh`
and start in `/tmp/lit-shell-multiplexing`. That initial-directory check is not
a filesystem sandbox; the shell can access anything permitted to the server's
OS account. The example limits both per-client and global session counts and
expires idle/orphaned sessions.

## Configuration

The following environment variables are intentionally opt-in:

| Variable                           | Default                       | Purpose                                             |
| ---------------------------------- | ----------------------------- | --------------------------------------------------- |
| `HOST`                             | `127.0.0.1`                   | Listen address; non-loopback values expose the demo |
| `PORT`                             | `3000`                        | HTTP and WebSocket port                             |
| `LIT_SHELL_ALLOWED_ORIGINS`        | Exact local origins           | Comma-separated canonical HTTP(S) browser origins   |
| `LIT_SHELL_WORKDIR`                | `/tmp/lit-shell-multiplexing` | Initial local-shell directory                       |
| `LIT_SHELL_VERBOSE`                | `false`                       | Enable diagnostic server logging                    |
| `LIT_SHELL_ENABLE_DOCKER`          | `false`                       | Enable Docker exec/attach support                   |
| `LIT_SHELL_EXPOSE_SESSION_DETAILS` | `false`                       | Add reduced session metadata to the stats API       |

When using a different hostname or reverse proxy, set the public origins
explicitly, for example
`LIT_SHELL_ALLOWED_ORIGINS=https://terminal.example.com`. Origin checks prevent
unwanted browser origins; they do not authenticate non-browser clients.

Docker mode accepts only container names matching `test-*`:

```bash
docker run --detach --name test-alpine alpine:3.23.5 sleep infinity
LIT_SHELL_ENABLE_DOCKER=true npm start
```

Enabling Docker mode disables local host-shell sessions. This prevents a local
shell from invoking the Docker CLI through daemon access and bypassing the
container-name allowlist. The connection panel will offer Docker modes instead.

Docker daemon access is equivalent to host-root access. Do not enable it on an
untrusted or internet-facing server.

## Health and statistics

The server exposes two read-only endpoints:

```bash
curl --fail http://127.0.0.1:3000/healthz
curl --fail http://127.0.0.1:3000/api/stats
```

Session details are excluded from `/api/stats` unless explicitly enabled.

## Tests

The lightweight HTTP tests exercise decoded traversal, symlink containment,
safe methods, HEAD handling, content types, and security headers:

```bash
npm test
npm audit --omit=dev
```
