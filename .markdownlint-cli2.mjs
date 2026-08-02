export default {
  config: {
    'line-length': false,
    'no-inline-html': false,
    'no-duplicate-heading': { siblings_only: true },
  },
  globs: [
    '**/*.md',
    '!**/node_modules/**',
    '!**/coverage/**',
    '!**/dist/**',
    '!**/_site/**',
    '!**/reports/**',
    '!**/test-results/**',
    '!.changeset/**',
    // Historical planning/output files are retained as project records.
    '!github-issues-plan.md',
    '!status.md',
  ],
};
