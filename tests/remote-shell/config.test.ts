import { describe, expect, it } from 'vitest';

import {
  loadRemoteDemoConfig,
  REMOTE_DEMO_LIMITS,
} from '../../deploy/remote-shell/config.js';

const PRODUCTION_SECRET = '0x-production-secret-with-enough-entropy';
const TURNSTILE_ALWAYS_PASS_TEST_SECRET = '1x0000000000000000000000000000000AA';
const TURNSTILE_ALWAYS_FAIL_TEST_SECRET = '2x0000000000000000000000000000000AA';

function productionEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    LIT_SHELL_ALLOWED_ORIGIN: 'https://www.idnteq.net',
    LIT_SHELL_TURNSTILE_SECRET_KEY: PRODUCTION_SECRET,
    ...overrides,
  };
}

describe('remote demo deployment configuration', () => {
  it('loads the complete shared-demo production configuration', () => {
    expect(
      loadRemoteDemoConfig(
        productionEnvironment({
          HOST: '127.0.0.1',
          PORT: '1234',
          RENDER_GIT_COMMIT: 'a'.repeat(40),
        }),
      ),
    ).toEqual({
      allowedOrigin: 'https://www.idnteq.net',
      buildRevision: 'a'.repeat(40),
      guestGid: 65_532,
      guestUid: 65_532,
      host: '127.0.0.1',
      launcherPath: '/usr/local/bin/lit-shell-guest',
      port: 1234,
      turnstileExpectedAction: 'remote_shell_admission',
      turnstileExpectedHostname: 'www.idnteq.net',
      turnstileSecretKey: PRODUCTION_SECRET,
      workspacePath: '/workspace/shared',
    });
  });

  it('uses safe network and revision defaults', () => {
    expect(loadRemoteDemoConfig(productionEnvironment())).toMatchObject({
      buildRevision: 'local',
      host: '0.0.0.0',
      port: 10_000,
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
    'https://EXAMPLE.test',
    'https://example.test:443',
    'not a url',
  ])('rejects unsafe or non-exact allowed origin %j', (origin) => {
    expect(() =>
      loadRemoteDemoConfig(
        productionEnvironment({ LIT_SHELL_ALLOWED_ORIGIN: origin }),
      ),
    ).toThrow(/LIT_SHELL_ALLOWED_ORIGIN/);
  });

  it.each(['0', '-1', '1.5', '65536', 'Infinity', 'not-a-port'])(
    'rejects invalid PORT=%s',
    (port) => {
      expect(() =>
        loadRemoteDemoConfig(productionEnvironment({ PORT: port })),
      ).toThrow(/PORT/);
    },
  );

  it.each([undefined, '', 'main', 'A'.repeat(40), 'a'.repeat(39)])(
    'uses local for absent or malformed build revision %j',
    (revision) => {
      expect(
        loadRemoteDemoConfig(
          productionEnvironment({ RENDER_GIT_COMMIT: revision }),
        ).buildRevision,
      ).toBe('local');
    },
  );

  it('keeps identity and filesystem boundaries fixed under hostile environment input', () => {
    const config = loadRemoteDemoConfig(
      productionEnvironment({
        LIT_SHELL_GUEST_GID: '0',
        LIT_SHELL_GUEST_UID: '0',
        LIT_SHELL_SANDBOX_LAUNCHER: '/tmp/attacker-controlled',
        LIT_SHELL_WORKSPACE: '/etc',
      }),
    );

    expect(config).toMatchObject({
      guestGid: 65_532,
      guestUid: 65_532,
      launcherPath: '/usr/local/bin/lit-shell-guest',
      workspacePath: '/workspace/shared',
    });
  });

  it('derives the Turnstile hostname from an allowed origin with a port', () => {
    expect(
      loadRemoteDemoConfig(
        productionEnvironment({
          LIT_SHELL_ALLOWED_ORIGIN: 'https://demo.example.test:8443',
        }),
      ).turnstileExpectedHostname,
    ).toBe('demo.example.test');
  });

  it.each([
    TURNSTILE_ALWAYS_PASS_TEST_SECRET,
    TURNSTILE_ALWAYS_FAIL_TEST_SECRET,
  ])(
    'supports Cloudflare test credential %s only on its fixed test origin',
    (testSecret) => {
      expect(
        loadRemoteDemoConfig({
          LIT_SHELL_ALLOWED_ORIGIN: 'https://example.com',
          LIT_SHELL_TURNSTILE_SECRET_KEY: testSecret,
        }),
      ).toMatchObject({
        turnstileExpectedAction: undefined,
        turnstileExpectedHostname: 'example.com',
        turnstileSecretKey: testSecret,
      });

      expect(() =>
        loadRemoteDemoConfig(
          productionEnvironment({
            LIT_SHELL_TURNSTILE_SECRET_KEY: testSecret,
          }),
        ),
      ).toThrow(/test secret.*only/u);
    },
  );

  it.each([
    [undefined, /LIT_SHELL_TURNSTILE_SECRET_KEY is required/u],
    ['', /LIT_SHELL_TURNSTILE_SECRET_KEY is required/u],
    ['short', /valid non-whitespace secret/u],
    ['a'.repeat(129), /valid non-whitespace secret/u],
    ['valid-secret-with space', /valid non-whitespace secret/u],
    ['valid-secret-with\nnewline', /valid non-whitespace secret/u],
    ['valid-secret-with-unicode-é', /valid non-whitespace secret/u],
    ['2x-not-the-known-public-test-secret', /failing public test key/u],
    ['3x0000000000000000000000000000000FF', /failing public test key/u],
    ['1x-not-the-known-public-test-secret', /unknown public test key/u],
  ])('rejects unsafe Turnstile secret %j', (secret, message) => {
    expect(() =>
      loadRemoteDemoConfig(
        productionEnvironment({
          LIT_SHELL_TURNSTILE_SECRET_KEY: secret,
        }),
      ),
    ).toThrow(message);
  });

  it.each(['a'.repeat(20), 'z'.repeat(128)])(
    'accepts a production secret at the supported length boundary',
    (secret) => {
      expect(
        loadRemoteDemoConfig(
          productionEnvironment({ LIT_SHELL_TURNSTILE_SECRET_KEY: secret }),
        ).turnstileSecretKey,
      ).toBe(secret);
    },
  );

  it('keeps shared resource limits mutually consistent', () => {
    expect(REMOTE_DEMO_LIMITS).toMatchObject({
      admissionCapacity: 4,
      idleTimeoutMs: 300_000,
      maxConnectionMessages: 4_096,
      maxVerificationBurst: 12,
      resetIntervalMs: 300_000,
      sessionLifetimeMs: 300_000,
      verificationRefillIntervalMs: 1_000,
    });
    expect(REMOTE_DEMO_LIMITS.activeLeaseMs).toBeGreaterThan(
      REMOTE_DEMO_LIMITS.sessionLifetimeMs,
    );
    expect(REMOTE_DEMO_LIMITS.pendingLeaseMs).toBeLessThan(
      REMOTE_DEMO_LIMITS.sessionLifetimeMs,
    );
    expect(REMOTE_DEMO_LIMITS.maxAdmissionBodyBytes).toBeGreaterThan(2_048);
    expect(REMOTE_DEMO_LIMITS.maxConcurrentVerifications).toBeLessThanOrEqual(
      REMOTE_DEMO_LIMITS.admissionCapacity,
    );
    expect(REMOTE_DEMO_LIMITS.maxVerificationBurst).toBeGreaterThanOrEqual(
      REMOTE_DEMO_LIMITS.maxConcurrentVerifications,
    );
  });
});
