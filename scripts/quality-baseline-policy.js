const coverageMetrics = ['branches', 'functions', 'lines', 'statements'];

export function validateCoverageBaseline(
  candidate,
  label = 'coverage baseline',
) {
  assertRecord(candidate, label);
  assertExactKeys(candidate, ['thresholds', 'version'], label);

  if (candidate.version !== 1) {
    throw new Error(`${label}.version must be 1`);
  }

  assertRecord(candidate.thresholds, `${label}.thresholds`);
  assertExactKeys(candidate.thresholds, coverageMetrics, `${label}.thresholds`);

  for (const metric of coverageMetrics) {
    assertFiniteNumber(
      candidate.thresholds[metric],
      `${label}.thresholds.${metric}`,
      { min: 0, max: 100 },
    );
  }

  return candidate;
}

export function validateCrapBaseline(candidate, label = 'CRAP baseline') {
  assertRecord(candidate, label);
  assertExactKeys(
    candidate,
    [
      'maxCrap',
      'methods',
      'methodsAboveThreshold',
      'newCodeThreshold',
      'unmeasuredMethods',
      'version',
    ],
    label,
  );

  if (candidate.version !== 1) {
    throw new Error(`${label}.version must be 1`);
  }

  assertFiniteNumber(candidate.newCodeThreshold, `${label}.newCodeThreshold`, {
    min: 0,
  });
  assertFiniteNumber(candidate.maxCrap, `${label}.maxCrap`, { min: 0 });
  assertNonNegativeInteger(
    candidate.methodsAboveThreshold,
    `${label}.methodsAboveThreshold`,
  );
  assertNonNegativeInteger(
    candidate.unmeasuredMethods,
    `${label}.unmeasuredMethods`,
  );
  assertRecord(candidate.methods, `${label}.methods`);

  let measuredMaximum = 0;
  let methodsAboveThreshold = 0;
  let unmeasuredMethods = 0;

  for (const [method, score] of Object.entries(candidate.methods)) {
    if (method.length === 0) {
      throw new Error(`${label}.methods contains an empty method key`);
    }

    if (score === null) {
      unmeasuredMethods += 1;
      continue;
    }

    assertFiniteNumber(score, `${label}.methods[${JSON.stringify(method)}]`, {
      min: 0,
    });
    measuredMaximum = Math.max(measuredMaximum, score);
    if (score > candidate.newCodeThreshold) methodsAboveThreshold += 1;
  }

  if (candidate.maxCrap !== measuredMaximum) {
    throw new Error(
      `${label}.maxCrap is ${candidate.maxCrap}, but the method maximum is ${measuredMaximum}`,
    );
  }
  if (candidate.methodsAboveThreshold !== methodsAboveThreshold) {
    throw new Error(
      `${label}.methodsAboveThreshold is ${candidate.methodsAboveThreshold}, but ${methodsAboveThreshold} methods exceed ${candidate.newCodeThreshold}`,
    );
  }
  if (candidate.unmeasuredMethods !== unmeasuredMethods) {
    throw new Error(
      `${label}.unmeasuredMethods is ${candidate.unmeasuredMethods}, but ${unmeasuredMethods} method scores are null`,
    );
  }

  return candidate;
}

export function compareQualityBaselines(current, base = {}) {
  assertRecord(current, 'current quality baselines');
  validateCrapBaseline(current.crap, 'current CRAP baseline');
  validateCoverageBaseline(current.coverage, 'current coverage baseline');

  assertRecord(base, 'base quality baselines');
  const failures = [];

  if (base.crap !== undefined) {
    validateCrapBaseline(base.crap, 'base CRAP baseline');
    failures.push(...compareCrapBaselines(current.crap, base.crap));
  }
  if (base.coverage !== undefined) {
    validateCoverageBaseline(base.coverage, 'base coverage baseline');
    failures.push(...compareCoverageBaselines(current.coverage, base.coverage));
  }

  return failures;
}

export function compareCoverageBaselines(current, base) {
  validateCoverageBaseline(current, 'current coverage baseline');
  validateCoverageBaseline(base, 'base coverage baseline');

  const failures = [];
  for (const metric of coverageMetrics) {
    if (current.thresholds[metric] < base.thresholds[metric]) {
      failures.push(
        `coverage.${metric} floor decreased: ${base.thresholds[metric]} -> ${current.thresholds[metric]}`,
      );
    }
  }
  return failures;
}

export function compareCrapBaselines(current, base) {
  validateCrapBaseline(current, 'current CRAP baseline');
  validateCrapBaseline(base, 'base CRAP baseline');

  const failures = [];

  if (current.newCodeThreshold > base.newCodeThreshold) {
    failures.push(
      `CRAP new-code threshold increased: ${base.newCodeThreshold} -> ${current.newCodeThreshold}`,
    );
  }
  if (current.maxCrap > base.maxCrap) {
    failures.push(
      `CRAP project maximum increased: ${base.maxCrap} -> ${current.maxCrap}`,
    );
  }

  const comparableBaseCount = Object.values(base.methods).filter(
    (score) => typeof score === 'number' && score > current.newCodeThreshold,
  ).length;
  if (current.methodsAboveThreshold > comparableBaseCount) {
    failures.push(
      `CRAP methods above ${current.newCodeThreshold} increased: ${comparableBaseCount} -> ${current.methodsAboveThreshold}`,
    );
  }
  if (current.unmeasuredMethods > base.unmeasuredMethods) {
    failures.push(
      `CRAP unmeasured methods increased: ${base.unmeasuredMethods} -> ${current.unmeasuredMethods}`,
    );
  }

  for (const [method, score] of Object.entries(current.methods)) {
    const wasTracked = Object.hasOwn(base.methods, method);
    const previous = wasTracked ? base.methods[method] : undefined;

    if (score === null) {
      if (typeof previous === 'number') {
        failures.push(`CRAP ${method} lost measured coverage`);
      } else if (!wasTracked) {
        failures.push(`CRAP ${method} is new and has no measured coverage`);
      }
      continue;
    }

    if (typeof previous === 'number' && score > previous) {
      failures.push(`CRAP ${method} increased: ${previous} -> ${score}`);
    } else if (!wasTracked && score > current.newCodeThreshold) {
      failures.push(
        `CRAP ${method} is new and exceeds ${current.newCodeThreshold}: ${score}`,
      );
    }
  }

  return failures;
}

function assertRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(
      `${label} must contain exactly: ${sortedExpected.join(', ')}`,
    );
  }
}

function assertFiniteNumber(value, label, { min, max = Infinity }) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${label} must be a finite number from ${min} to ${max}`);
  }
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}
