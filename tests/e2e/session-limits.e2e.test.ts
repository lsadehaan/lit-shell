import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { expectProtocolError, spawnSession } from './protocol-assertions.js';
import {
  startTestServer,
  testEnvironment,
  waitUntil,
  type StartedTestServer,
} from './protocol-harness.js';

const recordingShell = fileURLToPath(
  new URL('../fixtures/recording-shell.sh', import.meta.url),
);

describe('TerminalServer resource limits (black-box)', () => {
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

  it('enforces maxSessionsPerClient and frees capacity after close', async () => {
    server = await startTestServer({ maxSessionsPerClient: 1 });
    const client = await server.connect();
    const first = await spawnSession(client);
    const rejectedFrom = client.mark();

    client.send({
      type: 'spawn',
      options: { shell: '/bin/sh', cwd: process.cwd() },
    });

    await expectProtocolError(client, rejectedFrom);
    expect(
      client.messages
        .slice(rejectedFrom)
        .some((message) => message.type === 'spawned'),
    ).toBe(false);
    expect(server.terminal.getStats()).toMatchObject({
      sessionCount: 1,
      clientCount: 1,
    });

    const closeFrom = client.mark();
    client.send({ type: 'close', sessionId: first.id });
    await client.waitForType('sessionClosed', { from: closeFrom });
    const replacement = await spawnSession(client);
    expect(replacement.id).not.toBe(first.id);
    expect(server.terminal.getStats()).toMatchObject({
      sessionCount: 1,
      clientCount: 1,
    });
  });

  it('enforces maxClientsPerSession including the owner', async () => {
    server = await startTestServer({ maxClientsPerSession: 2 });
    const owner = await server.connect();
    const firstParticipant = await server.connect();
    const rejectedParticipant = await server.connect();
    const session = await spawnSession(owner, { allowJoin: true });
    firstParticipant.send({
      type: 'join',
      options: { sessionId: session.id, requestHistory: false },
    });
    await firstParticipant.waitForType('joined');
    const rejectedFrom = rejectedParticipant.mark();

    rejectedParticipant.send({
      type: 'join',
      options: { sessionId: session.id, requestHistory: false },
    });

    await expectProtocolError(rejectedParticipant, rejectedFrom);
    expect(server.terminal.getStats()).toMatchObject({
      sessionCount: 1,
      clientCount: 2,
    });
  });

  it('enforces maxSessionsPerClient when a client joins existing sessions', async () => {
    server = await startTestServer({ maxSessionsPerClient: 1 });
    const joiningClient = await server.connect();
    const sharingClient = await server.connect();
    const ownSession = await spawnSession(joiningClient);
    const sharedSession = await spawnSession(sharingClient, {
      allowJoin: true,
    });
    const rejectedFrom = joiningClient.mark();

    joiningClient.send({
      type: 'join',
      options: { sessionId: sharedSession.id, requestHistory: false },
    });

    const error = await expectProtocolError(joiningClient, rejectedFrom);
    expect(error.error).toMatch(/Maximum sessions \(1\) reached/);
    expect(server.terminal.getStats()).toMatchObject({
      sessionCount: 2,
      clientCount: 2,
    });

    const closeFrom = joiningClient.mark();
    joiningClient.send({ type: 'close', sessionId: ownSession.id });
    await joiningClient.waitForType('sessionClosed', { from: closeFrom });
    const joinFrom = joiningClient.mark();
    joiningClient.send({
      type: 'join',
      options: { sessionId: sharedSession.id, requestHistory: false },
    });
    await expect(
      joiningClient.waitForType('joined', { from: joinFrom }),
    ).resolves.toMatchObject({ sessionId: sharedSession.id });
  });

  it('rejects over-limit total sessions before starting another PTY process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lit-shell-e2e-lifecycle-'));
    temporaryDirectories.push(directory);
    const lifecycleLog = join(directory, 'started-pids.log');
    const environment = testEnvironment({
      LIT_SHELL_E2E_LIFECYCLE_LOG: lifecycleLog,
      LIT_SHELL_E2E_WATCHDOG_SECONDS: '3',
    });
    const starts = async (): Promise<string[]> => {
      try {
        return (await readFile(lifecycleLog, 'utf8'))
          .split(/\r?\n/)
          .filter(Boolean);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    };

    server = await startTestServer({
      allowedShells: [recordingShell],
      defaultShell: recordingShell,
      maxSessionsTotal: 1,
    });
    const firstClient = await server.connect();
    const rejectedClient = await server.connect();
    await spawnSession(firstClient, {
      shell: recordingShell,
      env: environment,
    });
    await waitUntil(async () => (await starts()).length === 1, {
      description: 'first PTY wrapper to record its process',
    });
    const rejectedFrom = rejectedClient.mark();

    rejectedClient.send({
      type: 'spawn',
      options: {
        shell: recordingShell,
        cwd: process.cwd(),
        env: environment,
      },
    });

    await expectProtocolError(rejectedClient, rejectedFrom);
    await delay(250);
    expect(await starts()).toHaveLength(1);
    expect(server.terminal.getStats()).toMatchObject({
      sessionCount: 1,
      clientCount: 1,
    });
  });
});
