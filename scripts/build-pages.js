#!/usr/bin/env node

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as esbuild from 'esbuild';
import {
  pagesOutputDirectory,
  pagesRemoteConfig,
} from './pages-remote-config.js';

const repositoryRoot = resolve(import.meta.dirname, '..');
const siteDirectory = pagesOutputDirectory(
  process.env.LIT_SHELL_PAGES_OUTPUT_DIR,
);
const siteRoot = resolve(repositoryRoot, siteDirectory);
const assetsRoot = resolve(siteRoot, 'assets');
const remoteRoot = resolve(siteRoot, 'remote');
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

const remoteConfig = pagesRemoteConfig(
  process.env.LIT_SHELL_REMOTE_DEMO_ORIGIN,
);
const remoteSourceHtml = await readFile(
  resolve(repositoryRoot, 'demo/remote/index.html'),
  'utf8',
);
const remoteHtml = replaceRequired(
  replaceRequired(
    replaceRequired(remoteSourceHtml, '__LIT_SHELL_BUILD__', buildRevision),
    '__LIT_SHELL_REMOTE_CONNECT_SRC__',
    remoteConfig.connectSource,
  ),
  '__LIT_SHELL_REMOTE_ORIGIN__',
  remoteConfig.origin,
);

await rm(siteRoot, { force: true, recursive: true });
await mkdir(assetsRoot, { recursive: true });
await mkdir(remoteRoot, { recursive: true });

await Promise.all([
  writeFile(resolve(siteRoot, 'index.html'), renderedHtml),
  writeFile(resolve(remoteRoot, 'index.html'), remoteHtml),
  copyFile(
    resolve(repositoryRoot, 'demo/style.css'),
    resolve(siteRoot, 'style.css'),
  ),
  copyFile(
    resolve(repositoryRoot, 'demo/favicon.svg'),
    resolve(siteRoot, 'favicon.svg'),
  ),
  copyFile(
    resolve(repositoryRoot, 'demo/remote/style.css'),
    resolve(remoteRoot, 'style.css'),
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
  esbuild.build({
    entryPoints: [resolve(repositoryRoot, 'demo/remote/app.ts')],
    bundle: true,
    define: {
      __LIT_SHELL_REMOTE_BUILD_MARKER__: JSON.stringify(
        `lit-shell-remote-build:${buildRevision}`,
      ),
    },
    format: 'esm',
    legalComments: 'eof',
    minify: true,
    outfile: resolve(assetsRoot, 'remote-demo.js'),
    platform: 'browser',
    sourcemap: false,
    target: ['es2022'],
  }),
]);

console.log(
  `GitHub Pages artifact built in ${siteDirectory}/ (${buildRevision}, remote ${remoteConfig.enabled ? 'enabled' : 'disabled'})`,
);

function replaceRequired(source, placeholder, value) {
  const rendered = source.replace(placeholder, value);
  if (rendered === source) {
    throw new Error(`Pages template is missing placeholder ${placeholder}`);
  }
  return rendered;
}
