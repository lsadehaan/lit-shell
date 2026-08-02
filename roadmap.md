# Roadmap

This roadmap communicates direction, not promised dates or guaranteed scope.
Priorities may change with security findings, maintainer capacity, and
community needs. Concrete work should be tracked in linked issues and small,
reviewable pull requests.

## Current foundations

### Quality and compatibility

- Keep Node.js compatibility explicit and exercise supported release lines in
  CI.
- Grow behavior-first unit, protocol, browser, and Python contract coverage.
- Lower coverage/complexity risk through the checked-in CRAP ratchet; never
  trade away assertions merely to improve a metric.
- Keep package exports, declaration files, browser bundles, examples, and
  dependency usage mechanically checked.
- Add bundle-size and performance budgets only after reproducible measurements
  establish useful baselines.

### Protocol confidence

- Specify message schemas, request correlation, errors, and lifecycle states as
  a versioned public compatibility boundary.
- Maintain parity between the Node server, JavaScript client, browser component,
  and Python binding.
- Exercise concurrency, limits, malformed input, session sharing, history,
  reconnects, and shutdown through black-box fixtures.
- Provide a deliberate compatibility and migration policy before a protocol
  version becomes externally negotiated.

### Secure integration

- Make authentication, authorization, origin validation, and reverse-proxy
  integration boundaries difficult to misunderstand.
- Prefer deny-by-default validation for shells, real working directories,
  containers, sessions, and resource limits.
- Keep secrets and terminal contents out of normal logs and diagnostics.
- Use automated dependency review, CodeQL, reproducible lockfile installs, npm
  trusted publishing, and package provenance as defense-in-depth controls.
- Explore rate limiting and structured audit hooks without presenting logs as
  an authorization or compliance system.

### Browser resilience and accessibility

- Preserve terminal state and resource ownership across tabs, disconnects,
  reconnects, and component teardown.
- Meet keyboard, focus, naming, status-announcement, and contrast expectations
  for connection controls and terminal tabs.
- Keep the published browser bundle self-contained and test it in Chromium,
  Firefox, and WebKit without relying on implementation-only hooks.
- Treat uncaught browser errors, console errors, and automated accessibility
  violations as regressions.
- Measure rendering, input latency, memory use, and bundle composition before
  choosing optimization work.

### Contributor experience

- Keep setup deterministic on the documented Node.js and Python versions.
- Turn common maintenance tasks into documented, local commands that match CI.
- Add focused examples and protocol documentation as public behavior stabilizes.
- Improve source maps, bundle analysis, troubleshooting, and typed diagnostics.
- Label approachable issues and recognize review, documentation, test, and code
  contributions—not only large features.

## Future candidates

The following ideas remain useful from earlier planning, but require an issue,
design review, security analysis, and a maintainer willing to own their ongoing
cost. Their presence here is not a commitment to implement them:

- health and metrics hooks suitable for integration with an application's
  observability stack;
- deployment and reverse-proxy guides with tested examples;
- terminal search, split panes, recording/playback, and richer theme tooling;
- framework-specific examples or thin wrappers where native custom-element
  integration is not sufficient;
- multi-instance session coordination and restart recovery with an explicit
  consistency and trust model; and
- extensibility points only where they preserve protocol compatibility and do
  not widen the server attack surface by default.

Large built-in identity providers, compliance claims, file transfer, analytics,
or a general plugin marketplace are intentionally not baseline promises. Those
features have substantial security and maintenance implications and need a
concrete user problem before design work begins.

## Historical note

The January 2026 roadmap described a pre-1.0 project, zero test coverage, and a
week-by-week release schedule. Those claims were superseded by the current
package, automated test foundation, and maintainer-capacity-based planning.
Still-relevant themes—resilience, accessibility, observability, documentation,
performance measurement, and resource cleanup—are carried forward above
without unsupported deadlines or numerical promises.

Suggestions are welcome through the feature proposal form. Security-sensitive
ideas and findings must use the private process in [SECURITY.md](SECURITY.md).
