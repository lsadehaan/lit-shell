import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeInstallScriptPolicy } from '../scripts/install-script-policy.js';

test('accepts exact approvals and name-wide denials for install scripts', () => {
  const result = analyzeInstallScriptPolicy(
    {
      allowScripts: {
        'esbuild@1.2.3': true,
        fsevents: false,
      },
    },
    lockfileWithScripts([
      ['node_modules/esbuild', '1.2.3'],
      ['node_modules/vite/node_modules/fsevents', '2.3.3'],
    ]),
  );

  assert.deepEqual(result, {
    installScriptPackages: ['esbuild@1.2.3', 'fsevents@2.3.3'],
    stalePolicyEntries: [],
    uncoveredLockEntries: [],
  });
});

test('rejects unpinned approvals even when they cover the installed name', () => {
  const result = analyzeInstallScriptPolicy(
    { allowScripts: { esbuild: true } },
    lockfileWithScripts([['node_modules/esbuild', '1.2.3']]),
  );

  assert.deepEqual(result.stalePolicyEntries, ['esbuild']);
  assert.deepEqual(result.uncoveredLockEntries, []);
});

test('reports stale approvals and newly uncovered script versions', () => {
  const result = analyzeInstallScriptPolicy(
    { allowScripts: { 'esbuild@1.2.2': true } },
    lockfileWithScripts([['node_modules/esbuild', '1.2.3']]),
  );

  assert.deepEqual(result.stalePolicyEntries, ['esbuild@1.2.2']);
  assert.deepEqual(result.uncoveredLockEntries, ['esbuild@1.2.3']);
});

test('rejects malformed decisions and unidentified script packages', () => {
  assert.throws(
    () =>
      analyzeInstallScriptPolicy(
        { allowScripts: { esbuild: 'yes' } },
        lockfileWithScripts([['node_modules/esbuild', '1.2.3']]),
      ),
    /must be boolean/,
  );
  assert.throws(
    () =>
      analyzeInstallScriptPolicy(
        { allowScripts: {} },
        { packages: { '': { hasInstallScript: true, version: '1.0.0' } } },
      ),
    /Root package install-time lifecycle scripts are prohibited/,
  );
  assert.throws(
    () =>
      analyzeInstallScriptPolicy(
        { allowScripts: {} },
        { packages: { unexpected: { hasInstallScript: true } } },
      ),
    /Cannot identify install-script dependency/,
  );
});

function lockfileWithScripts(entries) {
  return {
    packages: Object.fromEntries(
      entries.map(([packagePath, version]) => [
        packagePath,
        { hasInstallScript: true, version },
      ]),
    ),
  };
}
