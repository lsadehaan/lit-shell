# Pull request

## Summary

<!-- Explain the user-visible problem and the outcome of this change. -->

## Related issue

<!-- Use "Closes #123" when this should close an issue. -->

## Change type

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor or maintenance
- [ ] Tests
- [ ] Documentation or examples
- [ ] Dependency or build tooling
- [ ] Breaking API or protocol change

## Verification

<!-- List exact commands and manual scenarios. Explain any check that could not be run. -->

- [ ] `npm run validate`
- [ ] `npm run build`
- [ ] `npm run package:check`
- [ ] Added or updated tests for changed behavior
- [ ] Relevant protocol, browser, or Python E2E suite passes
- [ ] Exercised relevant cleanup, failure, and concurrency paths

<!-- Browser E2E: npm run test:e2e:browser; Python: cd bindings/python && python -m pytest -->

## Compatibility and security

<!-- Note wire-protocol, Node/browser/Python, bundle-size, dependency, migration, and threat-model effects. Write "None" when not applicable. Do not disclose an unpublished vulnerability in a public PR. -->

## Contributor checklist

- [ ] The change is focused and does not include unrelated formatting or refactoring.
- [ ] Public behavior and types remain compatible, or the breaking change and migration are documented.
- [ ] Protocol expectations come from the public contract, not implementation details or accepted defect variants.
- [ ] User-facing changes are reflected in the README or other relevant documentation.
- [ ] User-facing package changes include a Changeset (`npm run changeset`), or no Changeset is required.
- [ ] The CRAP baseline and coverage thresholds were not weakened to make this change pass.
- [ ] No credentials, private terminal output, generated `dist/` files, or unrelated lockfile changes are included.
- [ ] New or upgraded install scripts were reviewed and the pinned `allowScripts` policy is complete.
