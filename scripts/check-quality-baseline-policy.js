#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compareQualityBaselines } from './quality-baseline-policy.js';

const projectRoot = resolve(import.meta.dirname, '..');
const baselinePaths = {
  coverage: '.quality/coverage-ratchet.json',
  crap: '.quality/crap-ratchet.json',
};

const current = {
  coverage: await readWorkingTreeJson(baselinePaths.coverage),
  crap: await readWorkingTreeJson(baselinePaths.crap),
};
const requestedBaseRef = readBaseRef(process.argv.slice(2), process.env);

if (requestedBaseRef === undefined) {
  compareQualityBaselines(current);
  console.log(
    'Quality baseline policy passed (current structure checked; no base ref supplied).',
  );
  process.exit(0);
}

const commit = resolveCommit(requestedBaseRef);
const base = {};
for (const [kind, path] of Object.entries(baselinePaths)) {
  const baseline = readGitJson(commit, path);
  if (baseline !== undefined) base[kind] = baseline;
}

const failures = compareQualityBaselines(current, base);
if (failures.length > 0) {
  console.error(`Quality baseline policy failed against ${requestedBaseRef}:`);
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    'Improve the implementation or tests; do not weaken a checked-in quality baseline.',
  );
  process.exit(1);
}

const compared = Object.keys(base);
if (compared.length === 0) {
  console.log(
    `Quality baseline policy passed (baselines are new relative to ${requestedBaseRef}).`,
  );
} else {
  console.log(
    `Quality baseline policy passed against ${requestedBaseRef} (${compared.join(' and ')} compared).`,
  );
}

function readBaseRef(args, environment) {
  let argumentRef;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--base-ref') {
      argumentRef = args[index + 1];
      if (argumentRef === undefined) {
        throw new Error('--base-ref requires a git ref');
      }
      index += 1;
    } else if (argument.startsWith('--base-ref=')) {
      argumentRef = argument.slice('--base-ref='.length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  const baseRef =
    argumentRef ??
    environment.QUALITY_BASE_REF ??
    (environment.GITHUB_BASE_REF === undefined
      ? undefined
      : `origin/${environment.GITHUB_BASE_REF}`);
  const normalized = baseRef?.trim();
  if (normalized === undefined || normalized.length === 0) return undefined;
  if (/^0+$/.test(normalized)) return undefined;
  return normalized;
}

async function readWorkingTreeJson(path) {
  const absolutePath = resolve(projectRoot, path);
  try {
    return JSON.parse(await readFile(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read current baseline ${path}`, { cause: error });
  }
}

function resolveCommit(ref) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/@{}^~:+-]*$/.test(ref)) {
    throw new Error(`Invalid base git ref: ${ref}`);
  }

  try {
    return execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(`Cannot resolve base git ref: ${ref}`, { cause: error });
  }
}

function readGitJson(commit, path) {
  const object = `${commit}:${path}`;
  try {
    execFileSync('git', ['cat-file', '-e', object], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
  } catch {
    return undefined;
  }

  try {
    const contents = execFileSync('git', ['show', object], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Cannot read ${path} from ${commit}`, { cause: error });
  }
}
