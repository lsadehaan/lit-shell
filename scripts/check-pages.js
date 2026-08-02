#!/usr/bin/env node

import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const siteRoot = resolve(repositoryRoot, '_site');
const expectedFiles = [
  '.nojekyll',
  'assets/demo.js',
  'favicon.svg',
  'index.html',
  'style.css',
];
const maximumArtifactBytes = 1_500_000;

const actualFiles = await listFiles(siteRoot);
assertEqual(
  actualFiles,
  expectedFiles,
  'Pages artifact must contain only the reviewed allowlist',
);

let totalBytes = 0;
for (const filename of actualFiles) {
  const filePath = resolve(siteRoot, filename);
  const fileStats = await lstat(filePath);
  assert(fileStats.isFile(), `${filename} must be a regular file`);
  assert(!fileStats.isSymbolicLink(), `${filename} must not be a symlink`);
  totalBytes += (await stat(filePath)).size;
}
assert(
  totalBytes <= maximumArtifactBytes,
  `Pages artifact is unexpectedly large (${String(totalBytes)} bytes)`,
);

const html = await readFile(resolve(siteRoot, 'index.html'), 'utf8');
for (const required of [
  "default-src 'none'",
  "connect-src 'none'",
  "script-src 'self'",
  'href="./style.css"',
  'src="./assets/demo.js"',
  'Browser-only simulation',
]) {
  assert(html.includes(required), `index.html must include ${required}`);
}
assert(
  /<meta\s+name="lit-shell-build"\s+content="(?:local|[0-9a-f]{40})"\s*\/?>/u.test(
    html,
  ),
  'index.html must contain a normalized build revision',
);
assert(
  !html.includes('__LIT_SHELL_BUILD__'),
  'index.html build revision placeholder must be replaced',
);

assert(
  !/(?:href|src)=["']\/(?!\/)/u.test(html),
  'index.html must not use root-absolute assets',
);
assert(
  !/<(?:iframe|img|script|source)\b[^>]*\bsrc=["'](?:https?:)?\/\//iu.test(
    html,
  ) && !/<link\b[^>]*\bhref=["'](?:https?:)?\/\//iu.test(html),
  'index.html must not load third-party HTTP assets',
);
assert(
  !/<script(?![^>]*\bsrc=)[^>]*>/iu.test(html),
  'index.html must not contain inline scripts',
);

const bundle = await readFile(resolve(siteRoot, 'assets/demo.js'), 'utf8');
for (const forbidden of [
  'node:child_process',
  'node-pty',
  'child_process',
  'WebSocketServer',
]) {
  assert(
    !bundle.includes(forbidden),
    `browser bundle must not contain ${forbidden}`,
  );
}

console.log(
  `Pages artifact verified (${String(actualFiles.length)} files, ${String(totalBytes)} bytes)`,
);

async function listFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) =>
      relative(root, resolve(entry.parentPath, entry.name)).replaceAll(
        '\\',
        '/',
      ),
    )
    .sort();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`,
  );
}
