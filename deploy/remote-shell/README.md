# Hardened remote demo

This deployment runs the optional real-PTY demonstration linked from GitHub
Pages. It is intentionally a tiny, anonymous, single-user exhibit—not a
general-purpose hosted shell.

## Security boundary

The public Node gateway runs as UID/GID 65531. It accepts one short-lived,
one-use admission capability at a time, fixes every spawn option on the server,
and applies connection, input, output, idle, and wall-clock quotas. Admission
capabilities travel as WebSocket subprotocol offers; they are never placed in a
URL, cookie, or browser storage.

The gateway can execute only the root-owned, setuid supervisor at
`/usr/local/bin/lit-shell-sandbox`. That supervisor enters a root-owned,
read-only chroot, clears the environment and supplementary groups, changes to
UID/GID 65532, removes capabilities, enables `no_new_privs`, applies resource
limits and a seccomp policy, then starts a fixed interactive `dash`. The chroot
has no `/proc`, devices, compiler, package manager, network client, writable
directory, or persistent storage. Network, namespace, kernel IPC, mount,
tracing, and other dangerous syscalls are denied.

Startup and post-session recovery both run a real sandbox self-test. If the
host strips setuid, chroot, or seccomp support—or if a previous sandbox cannot
be proven gone—the readiness endpoint fails closed. Do not weaken that check to
make a hosting platform work.

These layers reduce risk; they do not make arbitrary untrusted computation
safe. Keep the image and host runtime patched, retain the hostile container
test in CI, and disable the public Pages endpoint immediately if the live smoke
test fails.

The endpoint is intentionally anonymous. Origin checks and CORS prevent
accidental cross-site use, but they are not identity or abuse controls: a
determined client can forge an `Origin` header and occupy the single public
slot. Treat repeated `busy` responses as an availability incident, monitor the
service, and disable the endpoint if it is abused. Never place sensitive data
or network-reachable services inside this demonstration boundary.

## Local verification

Build the exact image from the repository root:

```bash
docker build --file deploy/remote-shell/Dockerfile \
  --tag lit-shell-remote-demo .
```

Run it with a read-only outer filesystem and bounded host resources:

```bash
docker run --rm --read-only --memory 512m --pids-limit 64 \
  --publish 127.0.0.1:10000:10000 \
  --env LIT_SHELL_ALLOWED_ORIGIN=https://pages.test \
  lit-shell-remote-demo
```

`/health/live` reports process liveness and the build revision.
`/health/ready` is successful only while the sandbox boundary is healthy; its
`admission` field is `available`, `reserved`, or `active`.

CI additionally proves that:

- `no-new-privileges` stripping makes startup fail rather than degrade;
- host environment canaries, the outer filesystem, `/proc`, and PID 1 remain
  unreachable from the shell;
- the chroot is read-only and exposes only curated tools;
- a dropped WebSocket is fully cleaned before another visitor is admitted;
- CPU and protocol quotas terminate abusive sessions; and
- the final image contains no fixed high or critical known vulnerability.

## Render deployment

The root `render.yaml` is the canonical production configuration. It pins one
free Docker instance in Frankfurt, disables Render's independent auto-deploys,
and permits only `https://www.idnteq.net` as a browser origin. After the exact
GitHub CI gate passes, the master-branch CI job invokes a service-scoped Render
deploy hook for that commit and runs the live hostile smoke test. This avoids a
check/deployment cycle and prevents an untested commit from replacing the live
backend. Render's free service may sleep while idle, so the Pages UI performs an
explicit wake-up only after the visitor presses **Start real demo**.

Before enabling or changing the Pages endpoint:

1. deploy an exact reviewed commit;
2. require `/health/live` to report that commit;
3. run the live admission, WebSocket, shell-boundary, cleanup, and quota smoke;
4. set the public `REMOTE_DEMO_ORIGIN` repository variable; and
5. deploy and verify GitHub Pages.

The Pages site must be HTTPS-only. If a custom domain causes GitHub to report
an HTTP deployment URL, that URL must return an exact permanent redirect to
the expected HTTPS page; serving the demo itself over HTTP is a deployment
failure.

The Render API token is an operator credential. Keep it only in an approved
secret store, never in this repository, logs, shell history, browser code, or a
Render environment variable used by the demo.

Store the service's narrower deploy hook as the masked GitHub Actions secret
`RENDER_DEPLOY_HOOK_URL`. Treat that URL as a credential and rotate it if it is
ever exposed. The repository variable `REMOTE_DEMO_ORIGIN` must contain the
service's exact HTTPS origin.
