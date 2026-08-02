import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareQualityBaselines,
  validateCoverageBaseline,
  validateCrapBaseline,
} from '../scripts/quality-baseline-policy.js';

const baseCoverage = {
  version: 1,
  thresholds: {
    branches: 32,
    functions: 38,
    lines: 41,
    statements: 39,
  },
};

const baseCrap = {
  version: 1,
  newCodeThreshold: 8,
  maxCrap: 10,
  methodsAboveThreshold: 1,
  unmeasuredMethods: 1,
  methods: {
    measured: 4,
    legacy: 10,
    unmeasured: null,
  },
};

test('accepts internally consistent baseline schemas', () => {
  assert.equal(
    validateCoverageBaseline(structuredClone(baseCoverage)).version,
    1,
  );
  assert.equal(validateCrapBaseline(structuredClone(baseCrap)).version, 1);
});

test('rejects dishonest CRAP aggregates and invalid coverage floors', () => {
  const dishonestCrap = structuredClone(baseCrap);
  dishonestCrap.maxCrap = 9;
  assert.throws(
    () => validateCrapBaseline(dishonestCrap),
    /method maximum is 10/,
  );

  const invalidCoverage = structuredClone(baseCoverage);
  invalidCoverage.thresholds.lines = 101;
  assert.throws(
    () => validateCoverageBaseline(invalidCoverage),
    /finite number from 0 to 100/,
  );
});

test('allows first introduction and monotonic improvements', () => {
  const improvedCrap = {
    ...structuredClone(baseCrap),
    maxCrap: 8,
    methodsAboveThreshold: 0,
    methods: {
      measured: 3,
      legacy: 8,
    },
    unmeasuredMethods: 0,
  };
  const improvedCoverage = structuredClone(baseCoverage);
  improvedCoverage.thresholds.lines = 45;

  assert.deepEqual(
    compareQualityBaselines({ crap: improvedCrap, coverage: improvedCoverage }),
    [],
  );
  assert.deepEqual(
    compareQualityBaselines(
      { crap: improvedCrap, coverage: improvedCoverage },
      { crap: baseCrap, coverage: baseCoverage },
    ),
    [],
  );
});

test('rejects weaker coverage floors and CRAP ceilings', () => {
  const weakerCoverage = structuredClone(baseCoverage);
  weakerCoverage.thresholds.branches = 31.999;

  const weakerCrap = {
    ...structuredClone(baseCrap),
    maxCrap: 11,
    methodsAboveThreshold: 2,
    methods: {
      measured: 5,
      legacy: 11,
      unmeasured: null,
      newComplexMethod: 9,
    },
  };

  const failures = compareQualityBaselines(
    { crap: weakerCrap, coverage: weakerCoverage },
    { crap: baseCrap, coverage: baseCoverage },
  );

  assert(
    failures.some((failure) => failure.includes('branches floor decreased')),
  );
  assert(
    failures.some((failure) => failure.includes('project maximum increased')),
  );
  assert(
    failures.some((failure) => failure.includes('methods above 8 increased')),
  );
  assert(
    failures.some((failure) => failure.includes('measured increased: 4 -> 5')),
  );
  assert(
    failures.some((failure) => failure.includes('legacy increased: 10 -> 11')),
  );
  assert(
    failures.some((failure) => failure.includes('newComplexMethod is new')),
  );
});

test('rejects a weaker new-code threshold and lost coverage', () => {
  const weakerCrap = {
    ...structuredClone(baseCrap),
    newCodeThreshold: 9,
    unmeasuredMethods: 2,
    methods: {
      measured: null,
      legacy: 10,
      unmeasured: null,
    },
  };

  const failures = compareQualityBaselines(
    { crap: weakerCrap, coverage: baseCoverage },
    { crap: baseCrap },
  );

  assert(failures.some((failure) => failure.includes('threshold increased')));
  assert(
    failures.some((failure) => failure.includes('lost measured coverage')),
  );
  assert(
    failures.some((failure) =>
      failure.includes('unmeasured methods increased'),
    ),
  );
});
