import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

type CoverageThresholds = Record<
  'branches' | 'functions' | 'lines' | 'statements',
  number
>;

const coverageRatchet = JSON.parse(
  readFileSync(
    new URL('./.quality/coverage-ratchet.json', import.meta.url),
    'utf8',
  ),
) as { thresholds: CoverageThresholds };

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/browser/**'],
    passWithNoTests: false,
    restoreMocks: true,
    unstubGlobals: true,
    testTimeout: 5_000,
    hookTimeout: 5_000,
    coverage: {
      provider: 'v8',
      enabled: false,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/ui/xterm-styles.generated.ts'],
      reporter: ['text', 'json', 'lcov'],
      reportsDirectory: 'coverage',
      reportOnFailure: true,
      thresholds: {
        // The checked-in baseline policy rejects lower floors relative to the
        // PR/push base ref. Raise these after measured improvements.
        ...coverageRatchet.thresholds,
      },
    },
  },
});
