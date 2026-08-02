import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pagesOutputDirectory,
  pagesRemoteConfig,
} from '../scripts/pages-remote-config.js';

test('keeps the remote page network-disabled without a configured service', () => {
  assert.deepEqual(pagesRemoteConfig(undefined, undefined), {
    connectSource: "'none'",
    enabled: false,
    frameSource: "'none'",
    origin: '',
    scriptSource: "'self'",
    siteKey: '',
  });
});

test('derives exact HTTPS and WSS CSP sources from one normalized origin', () => {
  assert.deepEqual(
    pagesRemoteConfig('https://demo.example.test', '1x00000000000000000000AA'),
    {
      connectSource: 'https://demo.example.test wss://demo.example.test',
      enabled: true,
      frameSource: 'https://challenges.cloudflare.com',
      origin: 'https://demo.example.test',
      scriptSource: "'self' https://challenges.cloudflare.com",
      siteKey: '1x00000000000000000000AA',
    },
  );
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
    assert.throws(
      () => pagesRemoteConfig(candidate, '1x00000000000000000000AA'),
      {
        name: 'TypeError',
      },
    );
  });
}

test('requires the remote origin and public sitekey together', () => {
  assert.throws(
    () => pagesRemoteConfig('https://demo.example.test', undefined),
    /configured together/u,
  );
  assert.throws(
    () => pagesRemoteConfig(undefined, '1x00000000000000000000AA'),
    /configured together/u,
  );
});

for (const siteKey of ['short', 'contains a space', '<script>'.repeat(5)]) {
  test(`rejects malformed Turnstile sitekey ${JSON.stringify(siteKey)}`, () => {
    assert.throws(
      () => pagesRemoteConfig('https://demo.example.test', siteKey),
      /sitekey/u,
    );
  });
}

test('limits alternate Pages outputs to dedicated repository artifact names', () => {
  assert.equal(pagesOutputDirectory(undefined), '_site');
  assert.equal(pagesOutputDirectory('_site-enabled'), '_site-enabled');
  for (const unsafe of ['/', '..', '_site/child', 'dist', '_site-UPPER']) {
    assert.throws(() => pagesOutputDirectory(unsafe), { name: 'TypeError' });
  }
});
