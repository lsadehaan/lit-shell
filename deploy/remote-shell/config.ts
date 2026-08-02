const TURNSTILE_ALWAYS_PASS_TEST_SECRET = '1x0000000000000000000000000000000AA';
const TURNSTILE_ALWAYS_FAIL_TEST_SECRET = '2x0000000000000000000000000000000AA';

export const REMOTE_DEMO_LIMITS = Object.freeze({
  activeLeaseMs: 305_000,
  admissionCapacity: 4,
  idleTimeoutMs: 300_000,
  maxAdmissionBodyBytes: 8 * 1024,
  maxBufferedOutputBytes: 128 * 1024,
  maxConcurrentVerifications: 4,
  maxConnectionBytes: 128 * 1024,
  maxConnectionMessages: 0,
  maxInputBytes: 64 * 1024,
  maxMessageBytes: 8 * 1024,
  maxVerificationBurst: 12,
  maxOutputBytes: 512 * 1024,
  pendingLeaseMs: 10_000,
  resetIntervalMs: 300_000,
  sessionLifetimeMs: 300_000,
  verificationRefillIntervalMs: 1_000,
});

export interface RemoteDemoConfig {
  readonly allowedOrigin: string;
  readonly buildRevision: string;
  readonly guestGid: number;
  readonly guestUid: number;
  readonly host: string;
  readonly launcherPath: string;
  readonly port: number;
  readonly turnstileExpectedAction: string | undefined;
  readonly turnstileExpectedHostname: string;
  readonly turnstileSecretKey: string;
  readonly workspacePath: string;
}

export function loadRemoteDemoConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RemoteDemoConfig {
  const allowedOrigin = exactHttpsOrigin(
    requiredValue(
      environment.LIT_SHELL_ALLOWED_ORIGIN,
      'LIT_SHELL_ALLOWED_ORIGIN',
    ),
  );
  const turnstileSecretKey = turnstileSecret(
    requiredValue(
      environment.LIT_SHELL_TURNSTILE_SECRET_KEY,
      'LIT_SHELL_TURNSTILE_SECRET_KEY',
    ),
    allowedOrigin,
  );
  const testCredentials = isTurnstileTestSecret(turnstileSecretKey);

  return {
    allowedOrigin,
    buildRevision: normalizedRevision(environment.RENDER_GIT_COMMIT),
    guestGid: 65_532,
    guestUid: 65_532,
    host: environment.HOST || '0.0.0.0',
    launcherPath: '/usr/local/bin/lit-shell-guest',
    port: portNumber(environment.PORT || '10000'),
    turnstileExpectedAction: testCredentials
      ? undefined
      : 'remote_shell_admission',
    turnstileExpectedHostname: testCredentials
      ? 'example.com'
      : new URL(allowedOrigin).hostname,
    turnstileSecretKey,
    workspacePath: '/workspace/shared',
  };
}

function exactHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError('LIT_SHELL_ALLOWED_ORIGIN must be a valid URL', {
      cause: error,
    });
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) {
    throw new TypeError(
      'LIT_SHELL_ALLOWED_ORIGIN must be one exact HTTPS origin without credentials, path, query, or fragment',
    );
  }
  return url.origin;
}

function normalizedRevision(value: string | undefined): string {
  return value && /^[0-9a-f]{40}$/u.test(value) ? value : 'local';
}

function portNumber(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('PORT must be an integer from 1 to 65535');
  }
  return port;
}

function requiredValue(value: string | undefined, name: string): string {
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function turnstileSecret(value: string, allowedOrigin: string): string {
  if (
    value.length < 20 ||
    value.length > 128 ||
    /[^\u0021-\u007e]/u.test(value)
  ) {
    throw new TypeError(
      'LIT_SHELL_TURNSTILE_SECRET_KEY must be a valid non-whitespace secret',
    );
  }
  if (
    (value.startsWith('2x') || value.startsWith('3x')) &&
    value !== TURNSTILE_ALWAYS_FAIL_TEST_SECRET
  ) {
    throw new TypeError(
      'LIT_SHELL_TURNSTILE_SECRET_KEY must not use a failing public test key',
    );
  }
  if (value.startsWith('1x') && value !== TURNSTILE_ALWAYS_PASS_TEST_SECRET) {
    throw new TypeError(
      'LIT_SHELL_TURNSTILE_SECRET_KEY contains an unknown public test key',
    );
  }
  if (isTurnstileTestSecret(value) && allowedOrigin !== 'https://example.com') {
    throw new TypeError(
      'The public Turnstile test secret is allowed only with https://example.com',
    );
  }
  return value;
}

function isTurnstileTestSecret(value: string): boolean {
  return (
    value === TURNSTILE_ALWAYS_PASS_TEST_SECRET ||
    value === TURNSTILE_ALWAYS_FAIL_TEST_SECRET
  );
}
