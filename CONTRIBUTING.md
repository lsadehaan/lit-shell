# Contributing to lit-shell.js

Thank you for helping improve lit-shell.js. Contributions of code, tests,
documentation, examples, and careful bug reports are welcome.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
For vulnerabilities, use the private process in [SECURITY.md](SECURITY.md)
instead of opening a public issue.

## Before you start

- Search the existing issues and pull requests to avoid duplicate work.
- Use the appropriate issue form for a bug, feature proposal, or support
  question.
- Open an issue before a large feature, public API change, protocol change, or
  architectural rewrite. Early agreement prevents wasted effort.
- Small fixes, tests, and documentation improvements can go directly to a pull
  request.

## Development setup

The package requires Node.js 22.13+ on the Node.js 22 line, or Node.js 24+. CI
exercises Node.js 22, 24, and 26 plus Node.js 24 on Linux, macOS, and Windows;
Node.js 24 is the default for local development and quality automation. The
repository uses npm and its committed lockfile, so npm is the reference package
manager for JavaScript dependency changes.

`node-pty` is a native module. A C/C++ compiler, Python, and the platform tools
required by `node-gyp` may be needed during installation. See the upstream
`node-pty` installation documentation for platform-specific requirements.

```bash
git clone https://github.com/lsadehaan/lit-shell.git
cd lit-shell
npm ci
npm run deps:build
npm run validate
npm run build
```

Use `npm install` only when intentionally changing dependencies and commit the
resulting `package-lock.json` update with the manifest change. Do not use
`--legacy-peer-deps` to hide an invalid dependency graph.

Install-time scripts are an explicit supply-chain boundary. `.npmrc` disables
all lifecycle scripts during install; `npm run deps:build` deliberately
overrides that setting only while rebuilding the reviewed `esbuild` and
`node-pty` packages. `package.json` also records their exact reviewed versions
in npm's `allowScripts` ledger, and strict policy turns an unreviewed script
into a hard failure. After a dependency change, use npm 11.19 or newer to run
`npm approve-scripts --allow-scripts-pending`; inspect and approve only scripts
the project genuinely needs, then update the explicit rebuild command if the
approved set truly changes.

Useful commands:

| Command                       | Purpose                                               |
| ----------------------------- | ----------------------------------------------------- |
| `npm test`                    | Run unit and protocol tests once                      |
| `npm run test:watch`          | Run tests in watch mode                               |
| `npm run test:coverage`       | Run unit and protocol tests with coverage gates       |
| `npm run test:e2e:protocol`   | Run the real WebSocket/PTY protocol suite             |
| `npm run test:e2e:browser`    | Run browser E2E in Chromium, Firefox, and WebKit      |
| `npm run test:examples`       | Test example HTTP and static-file boundaries          |
| `npm run test:example-server` | Smoke-test the built multiplexing example             |
| `npm run test:pty-smoke`      | Spawn a real PTY with the current platform shell      |
| `npm run validate`            | Run formatting, lint, types, coverage, and CRAP gates |
| `npm run package:check`       | Build and validate exports and published types        |
| `npm run deps:check`          | Find unused files, exports, and dependencies          |
| `npm run deps:scripts:check`  | Reject unreviewed dependency install scripts          |
| `npm run docs:lint`           | Lint Markdown documentation                           |
| `npm run build`               | Compile declarations and create browser bundles       |
| `npm run build:browser`       | Rebuild only the browser bundles                      |
| `npm run watch`               | Compile TypeScript in watch mode                      |

Build output in `dist/` is generated and ignored. Do not add it to a pull
request.

For Python binding work, create an isolated environment and install the local
package with its development dependencies:

```bash
python3 -m venv .venv
. .venv/bin/activate
cd bindings/python
python -m pip install -e '.[dev]'
python -m ruff check .
python -m ruff format --check .
python -m mypy
python -m pytest -m 'not node_e2e' \
  --cov=lit_shell --cov-branch --cov-report=term-missing
python -m pip_audit .
python -m build
```

## Repository map

- `src/server/` contains WebSocket, PTY, and session-management code.
- `src/client/` contains the JavaScript WebSocket client.
- `src/ui/` contains the Lit web component and its styles.
- `src/shared/` contains wire-protocol and shared TypeScript types.
- `tests/` contains automated JavaScript and TypeScript tests.
- `bindings/python/` contains the Python client package.
- `examples/` contains runnable integration examples.
- `docker/` contains container deployment examples.

## Engineering expectations

lit-shell.js exposes an operating-system shell over a network connection.
Changes therefore need a higher security and lifecycle standard than a typical
UI component.

- Keep pull requests focused. Avoid unrelated formatting or refactoring.
- Prefer clear, typed interfaces and small modules with explicit ownership and
  cleanup behavior.
- Treat the wire protocol as a compatibility boundary. When changing it,
  update shared types and every applicable server, JavaScript client, UI, and
  Python binding path in the same change.
- Validate untrusted values at the server boundary. Cover rejection paths as
  well as successful paths.
- Release PTYs, WebSockets, timers, listeners, and DOM resources on every exit
  path, including errors and reconnects.
- Do not log credentials, authorization headers, environment secrets, or raw
  terminal content by default.
- Add a dependency only when it is maintained, appropriately licensed, and a
  better fit than a small use of an existing dependency or platform API.
  Consider browser bundle size, native build requirements, and server attack
  surface.

## Testing changes

Tests should verify externally observable behavior rather than reproduce the
implementation. A regression test should fail against the faulty behavior and
pass because the behavior was corrected, not because the test knows the shape
of the fix.

- Add focused unit tests for pure logic and boundary cases.
- Add integration or end-to-end coverage when behavior crosses the WebSocket,
  PTY, browser, or language-binding boundary.
- Include negative security cases for validation and authorization changes.
- Exercise concurrent requests, disconnects, cleanup, and timeouts where they
  are relevant.
- Avoid arbitrary sleeps. Prefer observable readiness conditions and bounded
  polling so tests remain deterministic.
- Ensure spawned processes, servers, sockets, and temporary files are cleaned
  up even when an assertion fails.

### Black-box protocol and browser tests

The protocol suites treat public messages and observable terminal behavior as
the contract. Their fixtures must not import implementation modules to derive
the expected answer, copy server parsing logic, or accept multiple responses
to accommodate a defect. Write the intended behavior first and allow a new
test to fail until the product is corrected.

The Playwright suite builds the consumer browser bundle and crosses a real
WebSocket and PTY boundary. It also fails on uncaught page errors, console
errors, accessibility violations, and lifecycle regressions. Install its
browsers before the first local run:

```bash
npx playwright install --with-deps chromium firefox webkit
npm run build
npm run test:e2e:browser
```

The Python fake-server suite is deliberately independent of the Node server.
The `node_e2e` marker then verifies the packaged Python client against a built
Node server and real `/bin/sh` PTY:

```bash
npm run build
cd bindings/python
python -m pytest
```

### Coverage and the CRAP ratchet

CRAP combines per-function cyclomatic complexity with test coverage. A high
score identifies code that is both difficult to reason about and poorly
protected by tests. The repository uses the maintained
`@barney-media/crap-typescript` implementation rather than a local variation
of the metric.

```bash
npm run test:coverage
npm run crap:report
npm run crap:ratchet
npm run quality:policy -- --base-ref origin/master
```

The report is written to `reports/`; generated coverage and reports are not
committed. The checked-in `.quality/crap-ratchet.json` records the reviewed
upper bound, while `.quality/coverage-ratchet.json` supplies Vitest's coverage
floors. `crap:ratchet` checks the generated report. `quality:policy` validates
both baseline schemas and compares them with a Git base, so a change cannot
raise CRAP ceilings or lower coverage floors. Improve tests or simplify code to
move the baselines downward. Never weaken a baseline merely to make a change
pass; a rare intentional policy change needs an explicit explanation and
maintainer review.

After a real reduction, run `npm run crap:baseline`, inspect the baseline diff,
and commit only the lowered limits. Raise coverage floors in
`.quality/coverage-ratchet.json` after a measured improvement; it is the single
source used by Vitest and the policy check. CI compares against the exact PR or
push base SHA. A local policy run without `--base-ref` still validates current
baseline integrity.

For changed functions, `npm run crap:changed` applies the stricter target of 8.
Treat it as design feedback even when an unchanged legacy function remains
under the repository-wide ratchet.

### Before submitting

Run the following for a JavaScript or TypeScript change:

```bash
npm run validate
npm run build
npm run package:check
```

Run the applicable browser and Python E2E suites when a change affects the UI,
wire protocol, server lifecycle, or Python binding. Document any
platform-specific limitation in the pull request. A skipped check should
include a reason; it should not be silently omitted.

## Commits and pull requests

The history generally follows Conventional Commit-style subjects such as
`fix:`, `feat:`, `test:`, `docs:`, and `chore:`. Use a short, imperative subject
and explain the reason for non-obvious changes in the body.

A ready-for-review pull request should:

- explain the user-visible problem and the chosen solution;
- link the relevant issue when one exists;
- include tests for changed behavior;
- call out protocol, API, security, dependency, and compatibility effects;
- update documentation and include a changeset for user-visible package
  changes; and
- pass the same build and test commands used by CI.

User-visible package changes use Changesets. Run `npm run changeset`, choose the
smallest correct semantic-version bump, and describe the consumer impact in
plain language. Tests, internal tooling, and documentation-only changes
normally do not need a changeset unless they alter the published package or
contributor-facing contract.

Do not publish from a maintainer checkout. Tagged releases are the only
supported publication path: the workflow repeats `npm run release:verify`,
publishes the verified tarball with npm trusted publishing, and is designed to
resume safely after a partial release. The npm package settings must disallow
traditional token publishing after the trusted publisher is configured.

Maintainers may ask for changes to scope, design, tests, or documentation.
Review focuses on correctness, security, maintainability, compatibility, and
the contributor experience. There is no contributor license agreement; your
contribution is provided under the repository's [MIT license](LICENSE).
