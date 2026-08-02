#!/usr/bin/env node

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as esbuild from 'esbuild';

const repositoryRoot = resolve(import.meta.dirname, '..');
const siteRoot = resolve(repositoryRoot, '_site');
const assetsRoot = resolve(siteRoot, 'assets');
const revisionCandidate = process.env.GITHUB_SHA ?? '';
const buildRevision = /^[0-9a-f]{40}$/u.test(revisionCandidate)
  ? revisionCandidate
  : 'local';

const sourceHtml = await readFile(
  resolve(repositoryRoot, 'demo/index.html'),
  'utf8',
);
const renderedHtml = sourceHtml.replace('__LIT_SHELL_BUILD__', buildRevision);
if (renderedHtml === sourceHtml) {
  throw new Error('demo/index.html is missing the build revision placeholder');
}

await rm(siteRoot, { force: true, recursive: true });
await mkdir(assetsRoot, { recursive: true });

await Promise.all([
  writeFile(resolve(siteRoot, 'index.html'), renderedHtml),
  copyFile(
    resolve(repositoryRoot, 'demo/style.css'),
    resolve(siteRoot, 'style.css'),
  ),
  copyFile(
    resolve(repositoryRoot, 'demo/favicon.svg'),
    resolve(siteRoot, 'favicon.svg'),
  ),
  writeFile(resolve(siteRoot, '.nojekyll'), ''),
  esbuild.build({
    entryPoints: [resolve(repositoryRoot, 'demo/app.ts')],
    bundle: true,
    format: 'esm',
    legalComments: 'eof',
    minify: true,
    outfile: resolve(assetsRoot, 'demo.js'),
    platform: 'browser',
    sourcemap: false,
    target: ['es2022'],
  }),
]);

console.log(`GitHub Pages artifact built in _site/ (${buildRevision})`);
