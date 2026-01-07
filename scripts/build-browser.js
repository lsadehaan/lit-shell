#!/usr/bin/env node
/**
 * Build browser bundles for x-shell.js
 */

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

async function build() {
  try {
    // Build client-only bundle (headless, no UI)
    console.log('Building client bundle...');
    await esbuild.build({
      entryPoints: [join(rootDir, 'src/client/index.ts')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2020'],
      outfile: join(rootDir, 'dist/client/browser-bundle.js'),
      sourcemap: true,
      minify: false,
      external: [],
    });
    console.log('✅ Client bundle: dist/client/browser-bundle.js');

    // Build UI bundle (includes Lit components)
    // Note: xterm.js is loaded dynamically from CDN, not bundled
    console.log('Building UI bundle...');
    await esbuild.build({
      entryPoints: [join(rootDir, 'src/ui/index.ts')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: ['es2020'],
      outfile: join(rootDir, 'dist/ui/browser-bundle.js'),
      sourcemap: true,
      minify: false,
      external: [
        // xterm.js is loaded dynamically from CDN
        'xterm',
        'xterm-addon-fit',
      ],
    });
    console.log('✅ UI bundle: dist/ui/browser-bundle.js');

  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
