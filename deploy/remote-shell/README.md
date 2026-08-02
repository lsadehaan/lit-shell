# Shared disposable remote demo

This deployment runs the optional real-PTY demonstration linked from GitHub
Pages. It is an anonymous, deliberately shared exhibit—not a private shell or
a general-purpose compute service. Never enter passwords, tokens, private keys,
personal data, or anything else that must remain confidential.

## Runtime model

One Render service container is the outer isolation boundary. Every visitor in
that instance shares one writable guest environment, including its files and
process namespace. The gateway permits at most four concurrent PTYs. All guest
shells run as the same fixed POSIX identity, UID/GID 65532, so visitors can
inspect, change, or delete one another's work and can interfere with one
another's processes. That messiness is intentional.

The entire guest epoch resets on one global five-minute schedule; the timer is
not restarted for each visitor. A visitor who arrives partway through an epoch
gets only the time remaining. At the boundary, the gateway closes every
connection, terminates every UID 65532 process, deletes and recreates
`/workspace/shared`, removes guest-owned System V IPC objects, clears admission
state, and begins the next epoch. Runtime-mounted shared-memory and lock
directories are root-owned and non-writable to the guest, so the workspace is
the only intended persistence surface inside an epoch. A service restart also
discards the environment. There is no persistent disk.

Render isolates this disposable container from its host and other customers.
There is intentionally no inner chroot, seccomp policy, per-visitor container,
or network namespace. Guest commands may read anything in the image that Unix
permissions expose and may attempt outbound network access. Keep this service
credential-free, do not connect it to private services, and treat its outbound
IP and availability as exposed to anonymous users.

## Gateway and human-verification boundary

The Node gateway starts as root because it owns lifecycle cleanup and creates
PTY children with a different identity. Its entrypoint clears supplementary
groups, enables `no_new_privs`, and retains only the small capability set needed
to change guest ownership and identity, kill guest processes, and reduce its
own capability bounding set. The gateway remains separate from all guest
shells; each local PTY is spawned directly as UID/GID 65532 with a fixed shell,
working directory, and sanitized environment. The guest cannot ask lit-shell
to choose another UID, GID, shell, or directory. Docker exec is disabled.

Cloudflare Turnstile is a hard admission gate, not merely a browser decoration.
The browser sends its response to `POST /v1/admissions`; the gateway verifies it
server-side with Cloudflare Siteverify and checks the expected hostname,
`remote_shell_admission` action, and token age. At most four Siteverify calls
can run concurrently. A global 12-attempt token bucket, refilling by one attempt
per second, bounds request rate without trusting proxy-supplied client-IP
headers. Because anonymous callers have no trustworthy identity, a sustained
attempt flood can consume that shared budget and temporarily deny admission;
it cannot produce a shell capability without a valid Turnstile proof. A
failed, malformed, stale, rate-limited, or unavailable verification fails
closed. Only a successful check produces a short-lived, one-use WebSocket
capability, and the gateway accepts no terminal upgrade without one.

Turnstile reduces automated access but does not identify a visitor or make the
shell private. The optional GitHub discussion link is the only interest signup,
and it is not connected to terminal admission or activity.

## Local Docker verification

Build the exact image from the repository root:

```bash
docker build --check --file deploy/remote-shell/Dockerfile .
docker build --file deploy/remote-shell/Dockerfile \
  --tag lit-shell-remote-demo .
```

Run it with the same outer controls exercised by CI:

```bash
docker run --rm --name lit-shell-remote-demo \
  --read-only \
  --tmpfs /tmp:mode=0755,size=8m \
  --tmpfs /workspace:mode=0755,size=32m \
  --cap-drop ALL \
  --cap-add CHOWN \
  --cap-add DAC_OVERRIDE \
  --cap-add KILL \
  --cap-add SETGID \
  --cap-add SETPCAP \
  --cap-add SETUID \
  --security-opt no-new-privileges:true \
  --memory 512m \
  --pids-limit 64 \
  --cpus 1 \
  --publish 127.0.0.1:10000:10000 \
  --env LIT_SHELL_ALLOWED_ORIGIN=https://example.com \
  --env LIT_SHELL_TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA \
  lit-shell-remote-demo
```

The `1x...AA` value is Cloudflare's public always-pass test secret. The server
accepts it only with the exact test origin `https://example.com`; it must never
be used in production. A real browser deployment needs a Turnstile site key and
secret from the same widget, an exact HTTPS Pages origin, and TLS in front of
the backend.

`GET /health/live` reports process liveness, the build revision, current epoch,
and next reset time. `GET /health/ready` returns `503` while an epoch is being
reset; otherwise it reports the same epoch data and admission counts with a
capacity of four.

CI additionally proves that:

- removing an identity capability makes startup fail closed;
- the gateway is root while every shell has only UID/GID/group 65532;
- four concurrent admissions are allowed, a fifth is refused, and separate
  PTYs share files;
- browser-only or invalid CAPTCHA claims cannot obtain terminal access;
- the guest receives no gateway environment secrets and cannot signal PID 1;
- runtime shared-memory and lock paths are guest-nonwritable, and guest-owned
  System V shared memory, queues, and semaphores are removed at reset;
- protocol, PTY, process, memory, and filesystem limits are enforced;
- the five-minute reset rejects post-close WebSocket frames, kills leftover
  guest processes, and erases shared files and IPC state; and
- the final image contains no fixed high or critical known vulnerability.

## Exact production configuration

The root [`render.yaml`](../../render.yaml) is canonical. It deploys exactly one
free Docker instance in Frankfurt from `master`, uses this Dockerfile, creates
no preview instances or persistent disk, and disables Render's independent
auto-deploys. The production mappings are:

| Location                    | Name                             | Required value                               |
| --------------------------- | -------------------------------- | -------------------------------------------- |
| Cloudflare Turnstile widget | Allowed hostname                 | `www.idnteq.net`                             |
| Cloudflare Turnstile widget | Mode                             | Managed                                      |
| Render environment          | `LIT_SHELL_ALLOWED_ORIGIN`       | `https://www.idnteq.net`                     |
| Render secret environment   | `LIT_SHELL_TURNSTILE_SECRET_KEY` | Secret from that same widget                 |
| GitHub Actions variable     | `REMOTE_DEMO_ORIGIN`             | `https://lit-shell-remote-demo.onrender.com` |
| GitHub Actions variable     | `RENDER_SERVICE_ID`              | Render service ID (`srv-...`)                |
| GitHub Actions variable     | `TURNSTILE_SITE_KEY`             | Public site key from that same widget        |
| GitHub environment secret   | `RENDER_API_TOKEN`               | Render API token with service deploy access  |

Render supplies `PORT` and `RENDER_GIT_COMMIT`; do not override them. Do not put
the Render API token in the service. The Turnstile secret belongs only in
Render's secret environment, the public site key belongs only in the GitHub
variable, and the Render API token belongs only in the masked GitHub secret.

After the exact GitHub CI gate passes, the production job asks the Render API to
deploy that exact commit without independently clearing the build cache, then
verifies the live revision and shared-demo control plane. The job is bound to
the `remote-demo-production` environment and its exact-`master` deployment
policy. Automatic and manually dispatched deploys both require `master`;
unmerged refs never receive the Render credential. Render's free service may
sleep while idle, so the Pages UI loads Turnstile only after the visitor presses
**Start real demo**, then wakes the service after the human check succeeds.
Pages is built with the exact backend origin and public site key only after both
are configured.

Before enabling or changing the Pages endpoint:

1. configure the Turnstile widget and the production mappings above;
2. deploy an exact reviewed commit through the CI-controlled Render API call;
3. require `/health/live` to report that commit;
4. require `/health/ready` to report a four-slot admission controller and a
   future reset time;
5. run the live admission, WebSocket, shared-state, identity, quota, and reset
   smoke tests; and
6. deploy and verify GitHub Pages.

The Pages site must be HTTPS-only. If its custom domain causes GitHub to report
an HTTP deployment URL, that URL must permanently redirect to the exact HTTPS
page. Serving either the page or terminal transport over plaintext HTTP is a
deployment failure.
