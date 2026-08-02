#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const reportPath = resolve(projectRoot, 'reports/crap.json');
const baselinePath = resolve(projectRoot, '.quality/crap-ratchet.json');
const update = process.argv.includes('--update');
const newCodeThreshold = 8;
const tolerance = 0.005;

const report = JSON.parse(await readFile(reportPath, 'utf8'));
if (!Array.isArray(report.methods)) {
  throw new Error(`Invalid CRAP report: ${reportPath}`);
}

const current = summarize(report.methods);

if (update) {
  await mkdir(dirname(baselinePath), { recursive: true });
  await writeFile(
    baselinePath,
    `${JSON.stringify(
      {
        version: 1,
        newCodeThreshold,
        maxCrap: current.maxCrap,
        methodsAboveThreshold: current.methodsAboveThreshold,
        unmeasuredMethods: current.unmeasuredMethods,
        methods: Object.fromEntries(
          [...current.methods].sort(([left], [right]) =>
            left.localeCompare(right, 'en'),
          ),
        ),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`Updated CRAP ratchet: ${baselinePath}`);
  process.exit(0);
}

const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
if (baseline.version !== 1 || typeof baseline.methods !== 'object') {
  throw new Error(`Unsupported CRAP ratchet baseline: ${baselinePath}`);
}

const failures = [];
if (current.maxCrap > baseline.maxCrap + tolerance) {
  failures.push(
    `worst score increased: ${baseline.maxCrap} -> ${current.maxCrap}`,
  );
}
if (current.methodsAboveThreshold > baseline.methodsAboveThreshold) {
  failures.push(
    `methods above ${newCodeThreshold} increased: ${baseline.methodsAboveThreshold} -> ${current.methodsAboveThreshold}`,
  );
}
if (current.unmeasuredMethods > baseline.unmeasuredMethods) {
  failures.push(
    `unmeasured methods increased: ${baseline.unmeasuredMethods} -> ${current.unmeasuredMethods}`,
  );
}

for (const [key, score] of current.methods) {
  const previous = baseline.methods[key];
  if (score === null) {
    if (typeof previous === 'number') {
      failures.push(`${key} lost measured coverage`);
    } else if (!(key in baseline.methods)) {
      failures.push(`${key} has no coverage`);
    }
    continue;
  }
  if (typeof previous === 'number' && score > previous + tolerance) {
    failures.push(`${key} regressed: ${previous} -> ${score}`);
  } else if (previous === undefined && score > newCodeThreshold + tolerance) {
    failures.push(`${key} is new and exceeds ${newCodeThreshold}: ${score}`);
  }
}

if (failures.length > 0) {
  console.error('CRAP ratchet failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    'Improve coverage/complexity; never raise the baseline to hide a regression.',
  );
  process.exit(1);
}

console.log(
  `CRAP ratchet passed (${current.methods.size} methods, max ${current.maxCrap}, ${current.methodsAboveThreshold} above ${newCodeThreshold}).`,
);

function summarize(methodEntries) {
  const occurrences = new Map();
  const methods = new Map();
  let maxCrap = 0;
  let methodsAboveThreshold = 0;
  let unmeasuredMethods = 0;

  const sorted = [...methodEntries].sort((left, right) =>
    `${left.src}\0${left.method}\0${left.lineStart}`.localeCompare(
      `${right.src}\0${right.method}\0${right.lineStart}`,
      'en',
    ),
  );

  for (const method of sorted) {
    const baseKey = `${method.src}::${method.method}`;
    const occurrence = (occurrences.get(baseKey) ?? 0) + 1;
    occurrences.set(baseKey, occurrence);
    const key = occurrence === 1 ? baseKey : `${baseKey}#${occurrence}`;
    const score = typeof method.crap === 'number' ? method.crap : null;
    methods.set(key, score);

    if (score === null) {
      unmeasuredMethods += 1;
    } else {
      maxCrap = Math.max(maxCrap, score);
      if (score > newCodeThreshold) methodsAboveThreshold += 1;
    }
  }

  return {
    maxCrap: round(maxCrap),
    methodsAboveThreshold,
    unmeasuredMethods,
    methods: new Map(
      [...methods].map(([key, score]) => [
        key,
        score === null ? null : round(score),
      ]),
    ),
  };
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
