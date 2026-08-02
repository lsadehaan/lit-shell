#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const projectRoot = resolve(import.meta.dirname, '..');
const write = process.argv.includes('--write');
const unknownArguments = process.argv
  .slice(2)
  .filter((value) => value !== '--write');
if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument: ${unknownArguments[0]}`);
}

const packageManifest = JSON.parse(
  await readFile(resolve(projectRoot, 'package.json'), 'utf8'),
);
const version = packageManifest.version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(
    'package.json version must be a stable numeric x.y.z release version',
  );
}

const targets = [
  {
    path: 'src/version.ts',
    pattern: /export const VERSION = '[^']+';/,
    replacement: `export const VERSION = '${version}';`,
  },
  {
    path: 'bindings/python/pyproject.toml',
    pattern: /^version = "[^"]+"$/m,
    replacement: `version = "${version}"`,
  },
  {
    path: 'bindings/python/lit_shell/__init__.py',
    pattern: /^__version__ = "[^"]+"$/m,
    replacement: `__version__ = "${version}"`,
  },
  {
    path: 'README.md',
    pattern:
      /(https:\/\/(?:unpkg\.com\/lit-shell\.js|cdn\.jsdelivr\.net\/npm\/lit-shell\.js))@[^/]+\/dist\/ui\/browser-bundle\.js/,
    replacement: `$1@${version}/dist/ui/browser-bundle.js`,
    matchCount: 3,
    replaceEveryMatch: true,
  },
];

const stale = [];
for (const target of targets) {
  const absolutePath = resolve(projectRoot, target.path);
  const contents = await readFile(absolutePath, 'utf8');
  const matches = contents.match(
    new RegExp(target.pattern.source, `${target.pattern.flags}g`),
  );
  const expectedMatchCount = target.matchCount ?? 1;
  if (matches?.length !== expectedMatchCount) {
    throw new Error(
      `${target.path} must contain exactly ${expectedMatchCount} public version marker${expectedMatchCount === 1 ? '' : 's'}`,
    );
  }

  const synchronized = target.replaceEveryMatch
    ? contents.replace(
        new RegExp(
          target.pattern.source,
          target.pattern.flags.includes('g')
            ? target.pattern.flags
            : `${target.pattern.flags}g`,
        ),
        target.replacement,
      )
    : contents.replace(target.pattern, target.replacement);
  if (synchronized === contents) continue;

  stale.push(target.path);
  if (write) await writeFile(absolutePath, synchronized, 'utf8');
}

if (!write) {
  const rootLock = JSON.parse(
    await readFile(resolve(projectRoot, 'package-lock.json'), 'utf8'),
  );
  if (
    rootLock.version !== version ||
    rootLock.packages?.['']?.version !== version
  ) {
    stale.push('package-lock.json');
  }

  for (const lockPath of [
    'examples/docker-container/package-lock.json',
    'examples/multiplexing/package-lock.json',
  ]) {
    const lock = JSON.parse(
      await readFile(resolve(projectRoot, lockPath), 'utf8'),
    );
    const linkedManifest = lock.packages?.['../..'];
    const dependencyFields = [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
      'peerDependenciesMeta',
    ];
    if (
      linkedManifest?.version !== version ||
      dependencyFields.some(
        (field) =>
          !isDeepStrictEqual(
            linkedManifest?.[field] ?? {},
            packageManifest[field] ?? {},
          ),
      )
    ) {
      stale.push(lockPath);
    }
  }
}

if (stale.length === 0) {
  console.log(`Public versions are synchronized at ${version}.`);
} else if (write) {
  console.log(`Synchronized ${stale.join(', ')} to ${version}.`);
} else {
  throw new Error(
    `Public versions or linked example package metadata do not match package.json ${version}: ${stale.join(', ')}. Refresh the affected markers and npm lockfiles.`,
  );
}
