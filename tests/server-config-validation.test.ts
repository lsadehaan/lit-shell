import { describe, expect, it } from 'vitest';

import {
  SessionManager,
  TerminalServer,
  type SessionManagerConfig,
  type TerminalServerOptions,
} from '../src/server/index.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_NODE_PTY_ID = 2_147_483_647;
const INVALID_INTEGER_VALUES = [
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
];

const POSITIVE_SERVER_LIMITS = [
  'maxSessionsPerClient',
  'maxSessionsTotal',
  'maxClientsPerSession',
  'maxMessageBytes',
  'maxBufferedOutputBytes',
  'cleanupInterval',
] as const;
const NON_NEGATIVE_SERVER_LIMITS = [
  'idleTimeout',
  'orphanTimeout',
  'historySize',
  'maxPreAuthMessages',
  'maxPreAuthBytes',
  'maxConnectionMessages',
  'maxConnectionBytes',
  'maxSessionInputBytes',
  'maxSessionOutputBytes',
  'maxSessionLifetime',
  'maxSessionsCreatedPerConnection',
] as const;

function terminalOptions(
  name: keyof TerminalServerOptions,
  value: number,
): TerminalServerOptions {
  return { [name]: value } as TerminalServerOptions;
}

function sessionManagerConfig(
  name: keyof SessionManagerConfig,
  value: number,
): SessionManagerConfig {
  return { [name]: value } as SessionManagerConfig;
}

describe('TerminalServer resource-limit configuration', () => {
  it('rejects a non-object constructor value at the runtime boundary', () => {
    expect(
      () => new TerminalServer(null as unknown as TerminalServerOptions),
    ).toThrow(/options must be an object/);
  });

  it.each(['server', 'port', 'misspelledLimit'])(
    'rejects unknown or removed constructor option %s',
    (name) => {
      expect(
        () => new TerminalServer({ [name]: 3000 } as TerminalServerOptions),
      ).toThrow(new RegExp(`unknown key: ${name}`));
    },
  );

  it.each([
    'allowLocalExec',
    'allowDockerExec',
    'allowSessionSharing',
    'historyEnabled',
    'verbose',
  ] as const)('rejects truthy string values for boolean option %s', (name) => {
    expect(
      () =>
        new TerminalServer({
          [name]: 'false',
        } as unknown as TerminalServerOptions),
    ).toThrow(new RegExp(`${name} must be a boolean`));
  });

  it.each([
    ['allowedShells', '/bin/sh'],
    ['allowedPaths', ['/tmp', 7]],
    ['allowedOrigins', ['https://example.test', '']],
    ['allowedContainerPatterns', [false]],
  ])('rejects malformed string-list option %s', (name, value) => {
    expect(
      () =>
        new TerminalServer({
          [name]: value,
        } as unknown as TerminalServerOptions),
    ).toThrow(new RegExp(name));
  });

  it.each([
    'defaultShell',
    'defaultCwd',
    'defaultContainerShell',
    'path',
    'dockerPath',
  ] as const)('rejects an empty string for %s', (name) => {
    expect(
      () => new TerminalServer({ [name]: '' } as TerminalServerOptions),
    ).toThrow(new RegExp(`${name} must be a non-empty string`));
  });

  it('rejects a non-function authorize policy', () => {
    expect(
      () =>
        new TerminalServer({
          authorize: true,
        } as unknown as TerminalServerOptions),
    ).toThrow(/authorize must be a function/);
  });

  it.each(['env', ['notARealOption'], ['shell', 7]])(
    'rejects malformed allowedClientOptions value %j',
    (value) => {
      expect(
        () =>
          new TerminalServer({
            allowedClientOptions: value,
          } as unknown as TerminalServerOptions),
      ).toThrow(/allowedClientOptions/);
    },
  );

  it.each([
    null,
    [],
    { 'NOT-PORTABLE': 'value' },
    { VALID: 7 },
    { VALID: undefined },
    { VALID: 'contains\0nul' },
  ])('rejects malformed localEnvironment value %j', (value) => {
    expect(
      () =>
        new TerminalServer({
          localEnvironment: value,
        } as unknown as TerminalServerOptions),
    ).toThrow(/localEnvironment/);
  });

  it('accepts an empty client-option allowlist and a sanitized environment', () => {
    const server = new TerminalServer({
      allowedClientOptions: [],
      localEnvironment: { PATH: '/usr/bin:/bin' },
    });

    expect(server.getStats()).toEqual({
      clientCount: 0,
      orphanedCount: 0,
      sessionCount: 0,
    });
    server.close();
  });

  it.each([{ localUid: 1000 }, { localGid: 1000 }] as TerminalServerOptions[])(
    'requires localUid and localGid to be configured together: %j',
    (options) => {
      expect(() => new TerminalServer(options)).toThrow(
        /localUid and localGid must be provided together/,
      );
    },
  );

  it.each([
    ['localUid', -1],
    ['localUid', 1.5],
    ['localUid', Number.NaN],
    ['localUid', Number.POSITIVE_INFINITY],
    ['localUid', MAX_NODE_PTY_ID + 1],
    ['localGid', -1],
    ['localGid', 1.5],
    ['localGid', Number.NaN],
    ['localGid', Number.POSITIVE_INFINITY],
    ['localGid', MAX_NODE_PTY_ID + 1],
  ] as const)('rejects invalid POSIX identity %s=%s', (name, value) => {
    expect(
      () =>
        new TerminalServer({
          localUid: name === 'localUid' ? value : 1000,
          localGid: name === 'localGid' ? value : 1000,
        }),
    ).toThrow(new RegExp(name));
  });

  it.each([
    ['localUid', '1000'],
    ['localUid', null],
    ['localGid', '1000'],
    ['localGid', null],
  ] as const)('rejects non-numeric POSIX identity %s=%s', (name, value) => {
    expect(
      () =>
        new TerminalServer({
          localUid: name === 'localUid' ? value : 1000,
          localGid: name === 'localGid' ? value : 1000,
        } as unknown as TerminalServerOptions),
    ).toThrow(new RegExp(name));
  });

  it.runIf(process.platform !== 'win32')(
    'accepts zero and the largest node-pty POSIX identity',
    () => {
      const zero = new TerminalServer({ localUid: 0, localGid: 0 });
      const largest = new TerminalServer({
        localUid: MAX_NODE_PTY_ID,
        localGid: MAX_NODE_PTY_ID,
      });

      zero.close();
      largest.close();
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects POSIX identity options on Windows',
    () => {
      expect(
        () => new TerminalServer({ localUid: 1000, localGid: 1000 }),
      ).toThrow(/not supported on Windows/);
    },
  );

  it.each(
    POSITIVE_SERVER_LIMITS.flatMap((name) =>
      [0, ...INVALID_INTEGER_VALUES].map((value) => [name, value] as const),
    ),
  )('rejects invalid positive limit %s=%s', (name, value) => {
    expect(() => new TerminalServer(terminalOptions(name, value))).toThrow(
      new RegExp(name),
    );
  });

  it.each(
    NON_NEGATIVE_SERVER_LIMITS.flatMap((name) =>
      INVALID_INTEGER_VALUES.map((value) => [name, value] as const),
    ),
  )('rejects invalid non-negative limit %s=%s', (name, value) => {
    expect(() => new TerminalServer(terminalOptions(name, value))).toThrow(
      new RegExp(name),
    );
  });

  it.each(['cleanupInterval', 'orphanTimeout', 'maxSessionLifetime'] as const)(
    'rejects timer overflow for %s',
    (name) => {
      expect(
        () => new TerminalServer(terminalOptions(name, MAX_TIMER_DELAY_MS + 1)),
      ).toThrow(new RegExp(name));
    },
  );

  it('accepts the documented zero-valued disable/immediate limits', () => {
    const server = new TerminalServer({
      idleTimeout: 0,
      orphanTimeout: 0,
      historySize: 0,
      maxPreAuthMessages: 0,
      maxPreAuthBytes: 0,
      maxConnectionMessages: 0,
      maxConnectionBytes: 0,
      maxSessionInputBytes: 0,
      maxSessionOutputBytes: 0,
      maxSessionLifetime: 0,
      maxSessionsCreatedPerConnection: 0,
    });

    expect(server.getStats()).toEqual({
      sessionCount: 0,
      clientCount: 0,
      orphanedCount: 0,
    });
    server.close();
  });

  it('accepts the largest timer-backed configuration value', () => {
    const server = new TerminalServer({
      cleanupInterval: MAX_TIMER_DELAY_MS,
      orphanTimeout: MAX_TIMER_DELAY_MS,
    });

    server.close();
  });
});

describe('SessionManager resource-limit configuration', () => {
  it.each([
    'maxClientsPerSession',
    'maxSessionsTotal',
    'maxBufferedOutputBytes',
  ] as const)('rejects zero for %s', (name) => {
    expect(() => new SessionManager(sessionManagerConfig(name, 0))).toThrow(
      new RegExp(name),
    );
  });

  it.each(
    (
      [
        'maxClientsPerSession',
        'maxSessionsTotal',
        'orphanTimeout',
        'historySize',
        'maxBufferedOutputBytes',
      ] as const
    ).flatMap((name) =>
      INVALID_INTEGER_VALUES.map((value) => [name, value] as const),
    ),
  )('rejects invalid limit %s=%s', (name, value) => {
    expect(() => new SessionManager(sessionManagerConfig(name, value))).toThrow(
      new RegExp(name),
    );
  });

  it('rejects timer overflow and accepts meaningful zero values', () => {
    expect(
      () => new SessionManager({ orphanTimeout: MAX_TIMER_DELAY_MS + 1 }),
    ).toThrow(/orphanTimeout/);

    const manager = new SessionManager({ orphanTimeout: 0, historySize: 0 });
    expect(manager.getStats()).toEqual({
      sessionCount: 0,
      clientCount: 0,
      orphanedCount: 0,
    });
    manager.cleanup();
  });
});
