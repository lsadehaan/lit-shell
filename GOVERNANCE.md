# Project governance

lit-shell.js is a maintainer-led open-source project. This document describes
how contributions become project decisions without implying a foundation,
company, or response-time guarantee that does not exist.

## Roles

### Contributors

Anyone who reports a reproducible problem, improves documentation, proposes a
design, reviews work, or submits code is a contributor. Contributions are
credited through Git history and release notes where applicable.

### Reviewers

Reviewers are contributors with demonstrated context in an area who regularly
provide accurate, constructive review. They may be asked to help triage issues
or review protocol, security, accessibility, Python, or release changes.
Reviewer status does not automatically grant repository write access.

### Maintainers

Maintainers have repository permissions and are accountable for project
direction, security handling, releases, and community enforcement. The current
maintainers are the people identified by the repository's GitHub permissions
and release history; no unaffiliated person should claim this role.

## Decisions and changes

Routine fixes use normal issue and pull-request review. Maintainers seek rough
consensus based on correctness, security, compatibility, maintenance cost, and
the project's scope. When consensus is not possible, a maintainer makes and
documents the decision so work can proceed.

Open an issue before a breaking API or protocol change, a new long-term
dependency, or a substantial architectural change. A proposal should explain
the user problem, threat-model and compatibility effects, alternatives, test
plan, and migration path. The amount of process should remain proportional to
the permanence and risk of the decision.

Maintainers may close proposals that are out of scope, unsafe, indefinitely
unmaintainable, or incompatible with the project direction. They should give a
clear reason and remain open to materially new evidence.

## Review and merge

Pull requests must pass the automated gates and satisfy
[CONTRIBUTING.md](CONTRIBUTING.md). Passing CI is necessary but not sufficient:
maintainers also review public behavior, security boundaries, cleanup,
compatibility, and maintainability. Authors must disclose generated code,
substantial automated assistance, and tests they could not run when that
context is material to review.

Small maintainer changes may be merged directly when delay would add no useful
review. High-risk protocol, release, or security changes should receive a
second review whenever another qualified reviewer is available.

## Releases

User-visible package changes use Changesets and semantic versioning. A release
tag must match `package.json`. The release workflow retests and packs the tagged
source, refuses tags outside `master`, and checks quality ratchets against the
previous release when available. It publishes that verified tarball through npm
trusted publishing and attaches it, the Python wheel and source distribution,
SHA-256 checksums, and a CycloneDX SBOM to the GitHub release. The publish step
requests npm provenance and uses the workflow's short-lived OIDC identity.

Publishing access is limited to maintainers who need it. The npm package should
configure `.github/workflows/release.yml` as its trusted GitHub publisher and
disallow traditional token publishing; a long-lived npm write token is not a
supported release path.

## Security and conduct

Security reports follow [SECURITY.md](SECURITY.md), not public design review.
Code of Conduct reports follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Maintainers must disclose conflicts of interest and recuse themselves when
appropriate. Urgent private action may precede public explanation when needed
to protect users or reporters.

## Continuity and amendments

Maintainers should avoid single-person operational knowledge by documenting
release, security, and automation changes in the repository. An inactive
maintainer may step down or have access removed after reasonable private
contact. New maintainers are selected for sustained, trustworthy contribution,
sound judgment, and willingness to uphold the project's security and community
responsibilities.

Governance changes use the same pull-request process as other project changes.
Material changes should explain the problem they solve and allow community
review before merge when practical.
