# Security policy

lit-shell.js provides remote access to operating-system shells. Treat every
server deployment as a privileged security boundary and report suspected
vulnerabilities privately.

## Supported versions

Security fixes are provided for the latest published release of each affected
package. Older releases may not receive backports.

| Release                               | Security support                         |
| ------------------------------------- | ---------------------------------------- |
| Latest npm or Python release artifact | Supported                                |
| Older releases                        | Not guaranteed; upgrade before reporting |

Reports against the current `master` branch are also welcome when they affect
code intended for a future release.

Supported releases require a maintained Node.js version that satisfies the
package engine (`^22.13.0 || >=24.0.0`). Reports that reproduce only on an
end-of-life runtime may require upgrading the runtime before triage.

## Reporting a vulnerability

Do not open a public issue, discussion, or pull request containing an
unpublished vulnerability.

Use [GitHub private vulnerability
reporting](https://github.com/lsadehaan/lit-shell/security/advisories/new) to
send the maintainers a report. If GitHub does not offer the private reporting
form, contact a maintainer through a private method published on the
[repository owner's GitHub profile](https://github.com/lsadehaan). Share only
enough in an initial contact to establish a private channel.

Please include, when available:

- the affected package version, commit, and component;
- deployment assumptions and required privileges;
- clear reproduction steps or a minimal proof of concept;
- the expected and observed security boundary;
- impact, including who can trigger the issue and what they can access;
- suggested mitigations or a patch, if you have one; and
- whether the issue has been disclosed anywhere else.

Remove real credentials, tokens, terminal history, and personal data from the
report. A purpose-built test account or container is preferred.

## What to expect

The maintainers aim to acknowledge a complete report within five business
days. Triage time depends on complexity and maintainer availability. The
reporter should receive an initial assessment, a request for more information,
or a proposed next step after triage. Material updates will be shared through
the private advisory until remediation and coordinated disclosure are
complete.

Please allow a reasonable remediation period before public disclosure. When a
fix is ready, the project may publish a GitHub security advisory, release a
patched version, and credit the reporter unless anonymity is requested.

## Deployment responsibilities

Shell and path allowlists reduce exposure but are not authentication,
authorization, or process isolation. The terminal protocol does not establish
an application user identity by itself. Deployers should:

> [!IMPORTANT]
> Compatibility defaults are permissive. Unless the host application adds its
> own checks, the terminal endpoint does not authenticate a WebSocket upgrade
> or enforce a restrictive browser `Origin` policy. New sessions are private
> and hidden from other clients by default; `allowJoin: true` is an explicit
> sharing decision. Session identifiers are routing identifiers, not
> authorization credentials.

- authenticate and authorize each WebSocket upgrade before it reaches the
  terminal server;
- bind session discovery, joining, writes, resize, leave, and kill operations
  to the authenticated principal's permissions;
- use TLS and a trusted origin policy for browser access;
- retain the private default and enable `allowJoin: true` only after all
  participants are authorized for that specific session;
- prevent cross-tenant session discovery and use separate terminal server
  instances or endpoints when an authorization-aware gateway cannot enforce
  tenant isolation;
- run the service as a dedicated, least-privileged account or inside an
  appropriately constrained container or sandbox;
- configure strict shell, working-directory, and container allowlists;
- set `allowLocalExec: false` whenever the server process can reach a Docker
  daemon; an allowed local shell could otherwise invoke the Docker client and
  bypass container-name allowlists;
- set session, idle, and resource limits appropriate to the environment;
- keep pre-authorization and per-message byte limits bounded for the deployment;
- keep lit-shell.js, Node.js, `node-pty`, `ws`, and the host operating system
  patched; and
- avoid exposing the terminal endpoint directly to an untrusted network.

Do not forward arbitrary client environment values into privileged processes,
and do not enable verbose logging where configuration or environment data may
contain secrets. Reverse proxies must preserve the authenticated identity and
must not allow an unauthenticated alternate path to the same upgrade endpoint.

Never rely on client-side UI controls to enforce a server-side permission.
Joining a session is not a read-only operation: a joined client can send input
to the shared PTY. Browser `Origin` validation is defense against unwanted web
origins, not proof of identity, and non-browser WebSocket clients can choose
their own `Origin` header.

Automated dependency review, CodeQL, tests, allowlists, and resource limits are
useful layers, but none of them turns a remotely reachable shell into a safe
anonymous service.

## Good-faith research

We support good-faith security research that avoids privacy violations,
service disruption, data destruction, and access beyond what is needed to
demonstrate the issue. Test only systems and accounts you own or have explicit
permission to assess. Do not use a finding to access other users' sessions or
data. Following this policy will be considered when the project evaluates a
report and any requested credit.
