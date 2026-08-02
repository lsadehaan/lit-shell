import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
  expectConnectionUsable,
  expectProtocolError,
} from './protocol-assertions.js';
import { startTestServer, type StartedTestServer } from './protocol-harness.js';

describe('TerminalServer strict protocol option shapes (black-box)', () => {
  let server: StartedTestServer | undefined;
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('rejects local execution before PTY creation when the server disables it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lit-shell-local-gate-'));
    temporaryDirectories.push(directory);
    const probeShell = join(directory, 'probe-shell');
    const spawnMarker = join(directory, 'spawned');
    await writeFile(
      probeShell,
      '#!/bin/sh\n: > "$LIT_SHELL_SPAWN_MARKER"\nexec /bin/sh\n',
    );
    await chmod(probeShell, 0o755);

    server = await startTestServer({
      allowLocalExec: false,
      allowDockerExec: true,
      allowedContainerPatterns: ['^test-.*$'],
      allowedShells: [probeShell],
      defaultShell: probeShell,
      allowedPaths: [directory],
      defaultCwd: directory,
    });
    const client = await server.connect();
    await expect(client.waitForType('serverInfo')).resolves.toMatchObject({
      info: { localEnabled: false, dockerEnabled: true },
    });
    const from = client.mark();

    client.send({
      type: 'spawn',
      requestId: 'blocked-local',
      options: {
        shell: probeShell,
        cwd: directory,
        env: { LIT_SHELL_SPAWN_MARKER: spawnMarker },
      },
    });

    const error = await expectProtocolError(client, from);
    expect(error).toMatchObject({ requestId: 'blocked-local' });
    expect(error.error).toMatch(/Local terminal execution is disabled/);
    expect(server.terminal.getStats()).toMatchObject({
      sessionCount: 0,
      clientCount: 0,
    });
    await delay(100);
    await expect(access(spawnMarker)).rejects.toThrow();
    await expectConnectionUsable(client);
  });

  it.each([
    ['spawn options', { type: 'spawn', options: { unexpected: true } }],
    ['session filter', { type: 'listSessions', filter: { unexpected: true } }],
    [
      'join options',
      {
        type: 'join',
        options: { sessionId: 'missing', unexpected: true },
      },
    ],
  ])('rejects unknown keys in %s', async (_description, message) => {
    server = await startTestServer();
    const client = await server.connect();
    const from = client.mark();

    client.send(message);

    const error = await expectProtocolError(client, from);
    expect(error.error).toMatch(/unknown key: unexpected/);
    expect(server.terminal.getStats().sessionCount).toBe(0);
    await expectConnectionUsable(client);
  });

  it.each([
    ['shell', '/bin/sh'],
    ['cwd', '/work'],
    ['containerShell', '/bin/sh'],
    ['containerUser', 'root'],
    ['containerCwd', '/work'],
    ['env', { DEBUG: 'true' }],
    ['useTmux', true],
    ['tmuxSession', 'debug'],
  ])(
    'rejects Docker attach option %s because attach cannot honor it',
    async (name, value) => {
      server = await startTestServer({ allowDockerExec: true });
      const client = await server.connect();
      const from = client.mark();

      client.send({
        type: 'spawn',
        options: {
          container: 'valid-container',
          attachMode: true,
          [name]: value,
        },
      });

      const error = await expectProtocolError(client, from);
      expect(error.error).toContain(name);
      expect(error.error).toMatch(/not supported for Docker attach/);
      expect(server.terminal.getStats().sessionCount).toBe(0);
    },
  );

  it.each([
    ['shell', '/bin/sh'],
    ['cwd', '/work'],
  ])(
    'rejects local option %s for a Docker exec session',
    async (name, value) => {
      server = await startTestServer({ allowDockerExec: true });
      const client = await server.connect();
      const from = client.mark();

      client.send({
        type: 'spawn',
        options: { container: 'valid-container', [name]: value },
      });

      const error = await expectProtocolError(client, from);
      expect(error.error).toContain(name);
      expect(error.error).toMatch(/not supported for Docker exec/);
      expect(server.terminal.getStats().sessionCount).toBe(0);
    },
  );

  it.each([
    ['containerShell', '/bin/sh'],
    ['containerUser', 'root'],
    ['containerCwd', '/work'],
    ['attachMode', false],
    ['useTmux', false],
    ['tmuxSession', 'debug'],
  ])(
    'rejects Docker-only option %s for a local session',
    async (name, value) => {
      server = await startTestServer();
      const client = await server.connect();
      const from = client.mark();

      client.send({ type: 'spawn', options: { [name]: value } });

      const error = await expectProtocolError(client, from);
      expect(error.error).toContain(name);
      expect(error.error).toMatch(/not supported for local/);
      expect(server.terminal.getStats().sessionCount).toBe(0);
    },
  );

  it('requires useTmux when a Docker exec tmuxSession name is supplied', async () => {
    server = await startTestServer({ allowDockerExec: true });
    const client = await server.connect();
    const from = client.mark();

    client.send({
      type: 'spawn',
      options: { container: 'valid-container', tmuxSession: 'debug' },
    });

    const error = await expectProtocolError(client, from);
    expect(error.error).toMatch(/tmuxSession requires useTmux: true/);
    expect(server.terminal.getStats().sessionCount).toBe(0);
  });
});
