#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const npmCli = process.env.npm_execpath;
if (npmCli === undefined) {
  throw new Error('Run this command through npm: npm run locks:examples');
}

const projectRoot = resolve(import.meta.dirname, '..');
const examples = ['examples/docker-container', 'examples/multiplexing'];
const locks = examples.map((directory) => {
  const lock = resolve(projectRoot, directory, 'package-lock.json');
  const modules = resolve(projectRoot, directory, 'node_modules');
  return {
    directory,
    lock,
    lockBackup: `${lock}.refresh-${process.pid}`,
    lockMoved: false,
    modules,
    modulesBackup: `${modules}.refresh-${process.pid}`,
    modulesMoved: false,
  };
});

try {
  for (const entry of locks) {
    await rename(entry.lock, entry.lockBackup);
    entry.lockMoved = true;
    entry.modulesMoved = await moveIfPresent(
      entry.modules,
      entry.modulesBackup,
    );
  }

  for (const { directory } of locks) {
    execFileSync(
      process.execPath,
      [
        npmCli,
        'install',
        '--prefix',
        directory,
        '--package-lock-only',
        '--ignore-scripts',
      ],
      { cwd: projectRoot, stdio: 'inherit' },
    );
  }

  for (const entry of locks) {
    await restoreModules(entry);
    await rm(entry.lockBackup);
    entry.lockMoved = false;
  }
  console.log('Refreshed example lockfiles from their package manifests.');
} catch (error) {
  for (const entry of locks) {
    await restoreModules(entry);
    if (entry.lockMoved) {
      await rm(entry.lock, { force: true });
      await rename(entry.lockBackup, entry.lock).catch(() => undefined);
    }
  }
  throw error;
}

async function moveIfPresent(source, destination) {
  try {
    await rename(source, destination);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function restoreModules(entry) {
  await rm(entry.modules, { force: true, recursive: true });
  if (entry.modulesMoved) {
    await rename(entry.modulesBackup, entry.modules);
    entry.modulesMoved = false;
  }
}
