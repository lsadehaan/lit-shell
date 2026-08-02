import { afterEach, describe, expect, it } from 'vitest';

import { expectProtocolError } from './protocol-assertions.js';
import { startTestServer, type StartedTestServer } from './protocol-harness.js';

describe('TerminalServer server-owned spawn policy (black-box)', () => {
  let server: StartedTestServer | undefined;

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
  });

  it.each([
    ['shell', '/bin/bash'],
    ['cwd', '/tmp'],
    ['env', { ATTACKER_VALUE: 'present' }],
    ['label', 'public'],
    ['allowJoin', true],
    ['enableHistory', true],
    ['orphanTimeout', 2_147_483_647],
  ])(
    'rejects client control of %s before creating a PTY',
    async (name, value) => {
      server = await startTestServer({
        allowedClientOptions: ['cols', 'rows'],
        localEnvironment: {
          HOME: process.cwd(),
          PATH: '/usr/bin:/bin',
          PS1: '',
          TERM: 'xterm-256color',
        },
      });
      const client = await server.connect();
      const from = client.mark();

      client.send({ type: 'spawn', options: { [name]: value } });

      const error = await expectProtocolError(client, from);
      expect(error.error).toBe(
        `spawn option is disabled by server policy: ${name}`,
      );
      expect(server.terminal.getStats()).toMatchObject({ sessionCount: 0 });
    },
  );

  it('uses only the server-owned environment while preserving safe dimensions', async () => {
    const secretName = 'LIT_SHELL_HOST_SECRET_DO_NOT_INHERIT';
    const previousSecret = process.env[secretName];
    process.env[secretName] = 'host-secret-value';
    try {
      server = await startTestServer({
        allowedClientOptions: ['cols', 'rows'],
        localEnvironment: {
          HOME: process.cwd(),
          LIT_SHELL_SAFE_ENV: 'server-owned',
          PATH: '/usr/bin:/bin',
          PS1: '',
          TERM: 'xterm-256color',
        },
      });
    } finally {
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
    }
    const client = await server.connect();
    const from = client.mark();

    client.send({
      type: 'spawn',
      options: { cols: 91, rows: 27 },
    });

    const spawned = await client.waitForType('spawned', { from });
    expect(spawned).toMatchObject({ cols: 91, rows: 27 });
    const sessionId = spawned.sessionId as string;
    const outputFrom = client.mark();
    client.send({
      type: 'data',
      sessionId,
      data: 'stty -echo; env\n',
    });
    const output = await client.waitForOutput(
      'LIT_SHELL_SAFE_ENV=server-owned',
      { from: outputFrom, sessionId },
    );
    expect(output).not.toContain(secretName);
    expect(output).not.toContain('host-secret-value');
  });
});
