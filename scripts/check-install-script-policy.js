#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const npmCli = process.env.npm_execpath;
if (npmCli === undefined) {
  throw new Error('Run this check through npm: npm run deps:scripts:check');
}

const output = execFileSync(
  process.execPath,
  [npmCli, 'approve-scripts', '--allow-scripts-pending', '--json'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);
const policy = JSON.parse(output);
if (!Array.isArray(policy.allowScripts)) {
  throw new Error(`Unexpected npm install-script policy output: ${output}`);
}

if (policy.allowScripts.length > 0) {
  console.error('Unreviewed dependency install scripts:');
  for (const dependency of policy.allowScripts) {
    console.error(`- ${String(dependency)}`);
  }
  process.exit(1);
}

console.log('Dependency install-script allowlist is complete.');
