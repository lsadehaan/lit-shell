---
'lit-shell.js': major
---

Harden the terminal protocol and container execution boundary, require Node.js
22.13 or newer, migrate to the maintained scoped xterm packages, and add
request correlation, reconnect recovery, and accessible multi-session UI
semantics. Sessions are now private and hidden by default; sharing requires
`allowJoin: true`, while owner reconnects use an opaque resume capability.
