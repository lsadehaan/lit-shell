#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptsDirectory, '..');
const source = join(
  repositoryRoot,
  'node_modules',
  '@xterm',
  'xterm',
  'css',
  'xterm.css',
);
const destination = join(
  repositoryRoot,
  'src',
  'ui',
  'xterm-styles.generated.ts',
);

const css = await readFile(source, 'utf8');
const generated = `// Generated from @xterm/xterm/css/xterm.css. Do not edit.\nexport const xtermStyles = ${JSON.stringify(css)};\n`;

let existing = '';
try {
  existing = await readFile(destination, 'utf8');
} catch (error) {
  if (
    !(error instanceof Error) ||
    !('code' in error) ||
    error.code !== 'ENOENT'
  ) {
    throw error;
  }
}

if (existing !== generated) await writeFile(destination, generated, 'utf8');
