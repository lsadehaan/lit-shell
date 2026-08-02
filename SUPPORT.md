# Support

lit-shell.js is maintained by the community on a best-effort basis. There is no
guaranteed response time or private implementation support.

## Start here

1. Read the [README](README.md) and the relevant example under `examples/`.
2. Search [existing issues](https://github.com/lsadehaan/lit-shell/issues),
   including closed issues.
3. Confirm the behavior with the latest release and a supported Node.js
   version (22.13+ on the Node.js 22 line, or Node.js 24+) when practical.

Then choose the most appropriate channel:

- Use the [bug report
  form](https://github.com/lsadehaan/lit-shell/issues/new?template=bug_report.yml)
  for reproducible defects.
- Use the [feature request
  form](https://github.com/lsadehaan/lit-shell/issues/new?template=feature_request.yml)
  for a new capability or public API proposal.
- Use the [question and support
  form](https://github.com/lsadehaan/lit-shell/issues/new?template=question.yml)
  when documentation and existing issues do not answer a usage question.
- Follow [SECURITY.md](SECURITY.md) for a suspected vulnerability. Never post
  unpublished security details in a public issue.

## Help us help you

A useful support request includes:

- the lit-shell.js version and affected server, client, UI, or Python binding;
- Node.js, browser, Python, operating-system, and container versions as
  applicable;
- a minimal, runnable reproduction;
- the relevant sanitized configuration;
- exact steps, expected behavior, and observed behavior; and
- the smallest useful log or error excerpt.

For contributor or source-build failures, also include the result of the
smallest relevant repository command (`npm run typecheck`, `npm test`,
`npm run test:e2e:browser`, or `python -m pytest` from `bindings/python`). Do
not paste an entire debug log when a focused excerpt reproduces the problem.

Terminal output and configuration often contain secrets. Redact credentials,
tokens, authorization headers, hostnames, usernames, command history, and
personal data before posting.

## Scope

The issue tracker can help with documented lit-shell.js APIs, reproducible
project defects, and focused enhancement proposals. General application
architecture, host administration, container hardening, reverse-proxy setup,
and bespoke debugging may be outside the maintainers' available capacity.

For contribution setup and review expectations, see
[CONTRIBUTING.md](CONTRIBUTING.md).
