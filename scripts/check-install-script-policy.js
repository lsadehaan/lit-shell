#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { analyzeInstallScriptPolicy } from './install-script-policy.js';

const projects = [
  ['root', new URL('../', import.meta.url)],
  [
    'docker-container example',
    new URL('../examples/docker-container/', import.meta.url),
  ],
  [
    'multiplexing example',
    new URL('../examples/multiplexing/', import.meta.url),
  ],
];
let identityCount = 0;
let invalidPolicy = false;

for (const [label, projectRoot] of projects) {
  const manifest = JSON.parse(
    readFileSync(new URL('package.json', projectRoot), 'utf8'),
  );
  const lockfile = JSON.parse(
    readFileSync(new URL('package-lock.json', projectRoot), 'utf8'),
  );
  const { installScriptPackages, stalePolicyEntries, uncoveredLockEntries } =
    analyzeInstallScriptPolicy(manifest, lockfile);
  identityCount += installScriptPackages.length;

  if (stalePolicyEntries.length > 0) {
    invalidPolicy = true;
    console.error(`${label}: stale or unpinned install-script policy entries:`);
    for (const policyKey of stalePolicyEntries) console.error(`- ${policyKey}`);
  }
  if (uncoveredLockEntries.length > 0) {
    invalidPolicy = true;
    console.error(`${label}: install-script dependencies missing from policy:`);
    for (const packageIdentity of uncoveredLockEntries) {
      console.error(`- ${packageIdentity}`);
    }
  }
}

const npmCli = process.env.npm_execpath;
if (npmCli === undefined) {
  throw new Error('Run this check through npm: npm run deps:scripts:check');
}

const output = execFileSync(
  process.execPath,
  [npmCli, 'install-scripts', 'ls', '--json'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);
const policy = JSON.parse(output);
if (!Array.isArray(policy.allowScripts)) {
  throw new Error(`Unexpected npm install-script policy output: ${output}`);
}

if (policy.allowScripts.length > 0) {
  invalidPolicy = true;
  console.error('Unreviewed dependency install scripts:');
  for (const dependency of policy.allowScripts) {
    console.error(`- ${String(dependency)}`);
  }
}

if (invalidPolicy) process.exit(1);

console.log(
  `Dependency install-script policy exactly covers ${identityCount} dependency identities across ${projects.length} projects.`,
);
