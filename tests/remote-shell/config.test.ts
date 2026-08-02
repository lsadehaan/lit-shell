import { describe, expect, it } from 'vitest';

import { loadRemoteDemoConfig } from '../../deploy/remote-shell/config.js';

describe('remote demo deployment configuration', () => {
  it('loads an exact production origin and normalizes the revision', () => {
    expect(
      loadRemoteDemoConfig({
        HOST: '127.0.0.1',
        LIT_SHELL_ALLOWED_ORIGIN: 'https://www.idnteq.net',
        PORT: '1234',
        RENDER_GIT_COMMIT: 'a'.repeat(40),
      }),
    ).toEqual({
      allowedOrigin: 'https://www.idnteq.net',
      buildRevision: 'a'.repeat(40),
      host: '127.0.0.1',
      launcherPath: '/usr/local/bin/lit-shell-sandbox',
      port: 1234,
    });
  });

  it.each([
    undefined,
    '',
    'http://www.idnteq.net',
    'https://user@example.test',
    'https://example.test/path',
    'https://example.test?query=yes',
    'https://example.test/#fragment',
    'not a url',
  ])('rejects unsafe allowed origin %j', (origin) => {
    expect(() =>
      loadRemoteDemoConfig({ LIT_SHELL_ALLOWED_ORIGIN: origin }),
    ).toThrow(/LIT_SHELL_ALLOWED_ORIGIN/);
  });

  it.each(['0', '1.5', '65536', 'not-a-port'])(
    'rejects invalid PORT=%s',
    (port) => {
      expect(() =>
        loadRemoteDemoConfig({
          LIT_SHELL_ALLOWED_ORIGIN: 'https://example.test',
          PORT: port,
        }),
      ).toThrow(/PORT/);
    },
  );

  it('uses local for an absent or malformed build revision', () => {
    expect(
      loadRemoteDemoConfig({
        LIT_SHELL_ALLOWED_ORIGIN: 'https://example.test',
        RENDER_GIT_COMMIT: 'main',
      }).buildRevision,
    ).toBe('local');
  });

  it('keeps the privileged launcher path fixed even if the environment is hostile', () => {
    expect(
      loadRemoteDemoConfig({
        LIT_SHELL_ALLOWED_ORIGIN: 'https://example.test',
        LIT_SHELL_SANDBOX_LAUNCHER: '/tmp/attacker-controlled',
      }).launcherPath,
    ).toBe('/usr/local/bin/lit-shell-sandbox');
  });
});
