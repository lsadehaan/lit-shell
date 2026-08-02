# CLAUDE.md

Guidance for Claude Code and other coding agents working in this repository.

## Project

`lit-shell.js` is an ESM-only WebSocket terminal library with three public
surfaces:

- `lit-shell.js/server`: Node.js WebSocket and `node-pty` server.
- `lit-shell.js/client`: browser/client protocol library with reconnection.
- `lit-shell.js/ui`: Lit-based `<lit-shell-terminal>` web component.

The Python client lives in `bindings/python`. The two runnable examples live in
`examples/docker-container` and `examples/multiplexing`.

## Supported tools

- Node.js `^22.13.0 || >=24.0.0`; CI covers Node 22, 24, and 26.
- npm is the canonical package manager. Keep `package-lock.json`; do not add a
  second JavaScript lockfile.
- Python 3.9 or newer for the optional Python binding.

TypeScript 6 is intentional: the typed lint and CRAP tooling consume the
TypeScript programmatic API, which TypeScript 7.0 does not provide.

## Commands

```bash
npm ci                    # Install the exact graph without lifecycle scripts
npm run deps:build        # Explicitly run only reviewed esbuild/node-pty scripts
npm run build             # Declarations plus browser bundles
npm test                  # Unit and real protocol E2E tests
npm run test:coverage     # Tests with ratcheted coverage floors
npm run test:e2e:browser # Chromium, Firefox, and WebKit black-box tests
npm run validate          # Full static, test, coverage, and CRAP gate
npm run package:check     # Build, publint, and package type/export checks
```

For the Python binding:

```bash
cd bindings/python
python -m pip install -e '.[dev]'
ruff check .
ruff format --check .
mypy
python -m pytest
```

## Quality rules

- Tests at `tests/e2e` exercise the public wire protocol through a real
  WebSocket and PTY. Browser tests consume built artifacts. Preserve these
  black-box boundaries; do not mock implementation details to make a defect
  pass.
- `.quality/crap-ratchet.json` and `.quality/coverage-ratchet.json` are
  monotonic. Improve code or tests when a gate fails. Never weaken a baseline
  to accommodate a regression.
- Run `npm run crap:report && npm run crap:ratchet` after changing TypeScript
  control flow. New methods must have measured CRAP of 8 or less.
- Keep the generated `src/ui/xterm-styles.generated.ts` synchronized through
  `npm run generate:assets`; do not hand-edit it.
- Add a Changeset for user-visible changes and keep TypeScript/Python protocol
  behavior aligned.

## Security invariants

This project exposes an operating-system shell. Treat protocol changes as a
security boundary.

- Sessions are private by default. Sharing must explicitly set
  `allowJoin: true` / `allow_join=True` and still requires application-level
  authorization.
- Authenticate with `authorize`, restrict `allowedOrigins`, shells, paths, and
  container patterns, and terminate TLS at the application or proxy boundary.
- Resume tokens are owner capabilities. They may appear only in direct spawn
  and authorized owner-resume responses, never in session listings or logs.
- Do not interpolate client input into shell commands. Docker operations use
  argument arrays and strict identifier validation.
- Keep pre-authorization limits and session/client caps fail-closed.

Read `SECURITY.md` before changing authentication, sharing, Docker access, or
WebSocket validation.

## Releases

Changesets document version impact. A `vX.Y.Z` tag must match `package.json`.
The release workflow re-runs all gates, packs one exact tarball, publishes that
verified artifact through npm trusted publishing/OIDC with provenance, and then
attaches it to the GitHub release. No long-lived `NPM_TOKEN` is used.
