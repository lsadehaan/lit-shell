import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pagesOutputDirectory,
  pagesRemoteConfig,
} from '../scripts/pages-remote-config.js';

test('keeps the remote page network-disabled without a configured service', () => {
  assert.deepEqual(pagesRemoteConfig(undefined), {
    connectSource: "'none'",
    enabled: false,
    origin: '',
  });
});

test('derives exact HTTPS and WSS CSP sources from one normalized origin', () => {
  assert.deepEqual(pagesRemoteConfig('https://demo.example.test'), {
    connectSource: 'https://demo.example.test wss://demo.example.test',
    enabled: true,
    origin: 'https://demo.example.test',
  });
});

for (const candidate of [
  'http://demo.example.test',
  'https://user@demo.example.test',
  'https://demo.example.test/path',
  'https://demo.example.test?query=yes',
  'https://demo.example.test/#fragment',
  'https://demo.example.test:443',
  'not a URL',
]) {
  test(`rejects unsafe remote origin ${JSON.stringify(candidate)}`, () => {
    assert.throws(() => pagesRemoteConfig(candidate), {
      name: 'TypeError',
    });
  });
}

test('limits alternate Pages outputs to dedicated repository artifact names', () => {
  assert.equal(pagesOutputDirectory(undefined), '_site');
  assert.equal(pagesOutputDirectory('_site-enabled'), '_site-enabled');
  for (const unsafe of ['/', '..', '_site/child', 'dist', '_site-UPPER']) {
    assert.throws(() => pagesOutputDirectory(unsafe), { name: 'TypeError' });
  }
});
