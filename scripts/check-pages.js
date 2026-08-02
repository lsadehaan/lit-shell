#!/usr/bin/env node

import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import {
  pagesOutputDirectory,
  pagesRemoteConfig,
} from './pages-remote-config.js';

const repositoryRoot = resolve(import.meta.dirname, '..');
const siteDirectory = pagesOutputDirectory(
  process.env.LIT_SHELL_PAGES_OUTPUT_DIR,
);
const siteRoot = resolve(repositoryRoot, siteDirectory);
const expectedFiles = [
  '.nojekyll',
  'assets/demo.js',
  'assets/remote-demo.js',
  'favicon.svg',
  'index.html',
  'remote/index.html',
  'remote/style.css',
  'style.css',
];
const maximumArtifactBytes = 2_500_000;
const remoteConfig = pagesRemoteConfig(
  process.env.LIT_SHELL_REMOTE_DEMO_ORIGIN,
);
const remoteCsp =
  `default-src 'none'; base-uri 'none'; connect-src ${remoteConfig.connectSource}; ` +
  "font-src 'self'; form-action 'none'; img-src 'self' data:; object-src 'none'; " +
  "script-src 'self'; style-src 'self' 'unsafe-inline'";

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
  'href="./remote/"',
]) {
  assert(html.includes(required), `index.html must include ${required}`);
}
assert(
  !html.includes('__LIT_SHELL_BUILD__'),
  'index.html build revision placeholder must be replaced',
);
assertPageStructure(html, 'index.html');

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

const remoteHtml = await readFile(
  resolve(siteRoot, 'remote/index.html'),
  'utf8',
);
const remoteBuildRevision = remoteHtml.match(
  /<meta\s+name="lit-shell-build"\s+content="(?<revision>local|[0-9a-f]{40})"\s*\/?>/u,
)?.groups?.revision;
assert(remoteBuildRevision, 'remote/index.html must expose its build revision');
for (const required of [
  `content="${remoteCsp}"`,
  `content="${remoteConfig.origin}"`,
  'src="../assets/remote-demo.js"',
  'href="../style.css"',
  'href="./style.css"',
  'Optional interest list',
  'discussions/34',
]) {
  assert(
    remoteHtml.includes(required),
    `remote/index.html must include ${required}`,
  );
}
assert(
  !remoteHtml.includes('__LIT_SHELL_'),
  'remote/index.html placeholders must be replaced',
);
assertPageStructure(remoteHtml, 'remote/index.html');
if (remoteConfig.enabled) {
  assert(
    !html.includes(remoteConfig.origin),
    'the safe simulator must not inherit the remote service origin',
  );
} else {
  assert(
    remoteHtml.includes("connect-src 'none'"),
    'an unconfigured remote page must remain network-disabled',
  );
}

const remoteBundle = await readFile(
  resolve(siteRoot, 'assets/remote-demo.js'),
  'utf8',
);
assert(
  remoteBundle.includes(`lit-shell-remote-build:${remoteBuildRevision}`),
  'remote browser bundle must match the remote HTML build revision',
);
for (const forbidden of [
  'node:child_process',
  'node-pty',
  'WebSocketServer',
  'localStorage',
  'sessionStorage',
]) {
  assert(
    !remoteBundle.includes(forbidden),
    `remote browser bundle must not contain ${forbidden}`,
  );
}

console.log(
  `Pages artifact verified in ${siteDirectory}/ (${String(actualFiles.length)} files, ${String(totalBytes)} bytes)`,
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

function assertPageStructure(document, name) {
  assert(
    /<meta\s+name="lit-shell-build"\s+content="(?:local|[0-9a-f]{40})"\s*\/?>/u.test(
      document,
    ),
    `${name} must contain a normalized build revision`,
  );
  assert(
    !/(?:href|src)=["']\/(?!\/)/u.test(document),
    `${name} must not use root-absolute assets`,
  );
  assert(
    !/<(?:iframe|img|script|source)\b[^>]*\bsrc=["'](?:https?:)?\/\//iu.test(
      document,
    ) && !/<link\b[^>]*\bhref=["'](?:https?:)?\/\//iu.test(document),
    `${name} must not load third-party HTTP assets`,
  );
  assert(
    !/<script(?![^>]*\bsrc=)[^>]*>/iu.test(document),
    `${name} must not contain inline scripts`,
  );
}
