export const REMOTE_DEMO_LIMITS = Object.freeze({
  activeLeaseMs: 65_000,
  idleTimeoutMs: 60_000,
  maxBufferedOutputBytes: 128 * 1024,
  maxConnectionBytes: 128 * 1024,
  maxConnectionMessages: 0,
  maxInputBytes: 64 * 1024,
  maxMessageBytes: 8 * 1024,
  maxOutputBytes: 512 * 1024,
  pendingLeaseMs: 10_000,
  sessionLifetimeMs: 60_000,
});

export interface RemoteDemoConfig {
  readonly allowedOrigin: string;
  readonly buildRevision: string;
  readonly host: string;
  readonly launcherPath: string;
  readonly port: number;
}

export function loadRemoteDemoConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RemoteDemoConfig {
  return {
    allowedOrigin: exactHttpsOrigin(
      requiredValue(
        environment.LIT_SHELL_ALLOWED_ORIGIN,
        'LIT_SHELL_ALLOWED_ORIGIN',
      ),
    ),
    buildRevision: normalizedRevision(environment.RENDER_GIT_COMMIT),
    host: environment.HOST || '0.0.0.0',
    launcherPath: '/usr/local/bin/lit-shell-sandbox',
    port: portNumber(environment.PORT || '10000'),
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
