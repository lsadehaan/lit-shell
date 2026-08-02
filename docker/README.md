# Containerized demo

The multi-stage image builds lit-shell with Node.js 24, installs only runtime
packages plus `node-pty`, and copies the Docker CLI from its official image. The
final server process runs as the image's unprivileged `node` user and includes a
readiness health check. Build frontend, runtime, CLI, and demo-container images
are pinned by tag and immutable digest; Dependabot proposes reviewed updates.

## Run

On Linux, provide the Docker socket group ID before starting the stack:

```bash
export DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
docker compose --file docker/docker-compose.yml up --build
```

Then open <http://127.0.0.1:3000>. The two allowed demo containers are named
`test-alpine` and `test-ubuntu`. Local host-shell sessions are disabled so they
cannot use the mounted Docker socket to bypass the container-name allowlist.

> [!WARNING]
> A read-only Docker socket mount still permits privileged daemon operations.
> Socket access is equivalent to host-root access. The demo is unauthenticated,
> publishes only on loopback, restricts browser WebSockets to exact local
> origins, and must not be exposed to untrusted users. Origin checks are not
> authentication for non-browser clients.

Validate the Compose model without starting containers:

```bash
DOCKER_GID=999 docker compose --file docker/docker-compose.yml config --quiet
```
