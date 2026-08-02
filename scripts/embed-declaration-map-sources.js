#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const distRoot = resolve(projectRoot, 'dist');
let updated = 0;

for (const mapPath of await declarationMaps(distRoot)) {
  const sourceMap = JSON.parse(await readFile(mapPath, 'utf8'));
  if (!Array.isArray(sourceMap.sources) || sourceMap.sources.length === 0) {
    throw new Error(`Declaration map has no sources: ${mapPath}`);
  }

  sourceMap.sourcesContent = await Promise.all(
    sourceMap.sources.map(async (source) => {
      if (typeof source !== 'string' || source.length === 0) {
        throw new Error(`Declaration map has an invalid source: ${mapPath}`);
      }
      const sourcePath = resolve(
        dirname(mapPath),
        sourceMap.sourceRoot ?? '',
        source,
      );
      const projectRelative = relative(projectRoot, sourcePath);
      if (
        isAbsolute(projectRelative) ||
        projectRelative === '..' ||
        projectRelative.startsWith(`..${sep}`)
      ) {
        throw new Error(
          `Declaration map source escapes the project: ${source}`,
        );
      }
      return readFile(sourcePath, 'utf8');
    }),
  );

  await writeFile(mapPath, `${JSON.stringify(sourceMap)}\n`, 'utf8');
  updated += 1;
}

if (updated === 0) throw new Error('No declaration maps were generated');
console.log(`Embedded source content in ${updated} declaration maps.`);

async function declarationMaps(directory) {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...(await declarationMaps(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.d.ts.map')) {
      matches.push(entryPath);
    }
  }
  return matches.sort();
}
