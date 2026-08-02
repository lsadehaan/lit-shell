import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeShellQuiet, spawnSession } from './protocol-assertions.js';
import {
  printCommand,
  startTestServer,
  testEnvironment,
  waitUntil,
  type StartedTestServer,
} from './protocol-harness.js';

describe('TerminalServer terminal I/O (black-box)', () => {
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

  it('spawns a real shell and returns its output as session-scoped data', async () => {
    server = await startTestServer();
    const client = await server.connect();
    const session = await spawnSession(client);
    await makeShellQuiet(client, session);
    const marker = `SHELL_OUTPUT_${randomUUID()}`;
    const from = client.mark();

    client.send({
      type: 'data',
      sessionId: session.id,
      data: printCommand(marker),
    });

    const output = await client.waitForOutput(marker, {
      sessionId: session.id,
      from,
    });
    expect(output).toContain(marker);
    const dataMessages = client.messages.slice(from).filter((message) => {
      return (
        message.type === 'data' && message.data?.toString().includes(marker)
      );
    });
    expect(dataMessages.length).toBeGreaterThan(0);
    expect(
      dataMessages.every((message) => message.sessionId === session.id),
    ).toBe(true);
  });

  it('applies resize messages to the underlying PTY', async () => {
    server = await startTestServer();
    const client = await server.connect();
    const session = await spawnSession(client);
    await makeShellQuiet(client, session);
    const from = client.mark();

    client.send({
      type: 'resize',
      sessionId: session.id,
      cols: 103,
      rows: 37,
    });
    client.send({
      type: 'data',
      sessionId: session.id,
      data: 'stty size\n',
    });

    const output = await client.waitForOutput(/(?:^|\r?\n)37 103(?:\r?\n|$)/, {
      sessionId: session.id,
      from,
    });
    expect(output).toMatch(/(?:^|\r?\n)37 103(?:\r?\n|$)/);
  });

  it('honors the requested working directory and environment', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'lit-shell-e2e-cwd-'));
    temporaryDirectories.push(cwd);
    const environmentMarker = `ENV_${randomUUID()}`;
    server = await startTestServer({
      allowedPaths: [cwd],
      defaultCwd: cwd,
    });
    const client = await server.connect();
    const session = await spawnSession(client, {
      cwd,
      env: testEnvironment({ LIT_SHELL_E2E_VALUE: environmentMarker }),
    });
    await makeShellQuiet(client, session);
    const from = client.mark();

    client.send({
      type: 'data',
      sessionId: session.id,
      data: `pwd; printf '%s\\n' "$LIT_SHELL_E2E_VALUE"\n`,
    });

    const output = await client.waitForOutput(environmentMarker, {
      sessionId: session.id,
      from,
    });
    expect(output).toContain(cwd);
    expect(output).toContain(environmentMarker);
  });

  it('reports the real shell exit code and removes the session', async () => {
    server = await startTestServer();
    const client = await server.connect();
    const session = await spawnSession(client);
    const from = client.mark();

    client.send({
      type: 'data',
      sessionId: session.id,
      data: 'exit 17\n',
    });

    const exited = await client.waitForType('exit', { from });
    expect(exited).toMatchObject({
      type: 'exit',
      sessionId: session.id,
      exitCode: 17,
    });
    await waitUntil(() => server!.terminal.getStats().sessionCount === 0, {
      description: 'exited PTY session to be removed',
    });
  });

  it('lets the owner close a session and tells participants why it closed', async () => {
    server = await startTestServer();
    const owner = await server.connect();
    const participant = await server.connect();
    const session = await spawnSession(owner, { allowJoin: true });
    participant.send({
      type: 'join',
      options: { sessionId: session.id, requestHistory: false },
    });
    await participant.waitForType('joined');
    const ownerFrom = owner.mark();
    const participantFrom = participant.mark();

    owner.send({
      type: 'close',
      sessionId: session.id,
      requestId: 'owner-close-request',
    });

    const [ownerClosed, participantClosed] = await Promise.all([
      owner.waitForType('sessionClosed', { from: ownerFrom }),
      participant.waitForType('sessionClosed', { from: participantFrom }),
    ]);
    for (const message of [ownerClosed, participantClosed]) {
      expect(message).toMatchObject({
        type: 'sessionClosed',
        sessionId: session.id,
        reason: 'owner_closed',
      });
    }
    expect(ownerClosed).toMatchObject({ requestId: 'owner-close-request' });
    expect(participantClosed.requestId).toBeUndefined();
    await waitUntil(() => server!.terminal.getStats().sessionCount === 0, {
      description: 'closed PTY session to be removed',
    });
  });

  it('correlates an error when closing a session that does not exist', async () => {
    server = await startTestServer();
    const client = await server.connect();
    const from = client.mark();

    client.send({
      type: 'close',
      sessionId: 'missing-session',
      requestId: 'missing-close-request',
    });

    await expect(
      client.waitFor(
        (message) => message.requestId === 'missing-close-request',
        { from },
      ),
    ).resolves.toMatchObject({
      type: 'error',
      requestId: 'missing-close-request',
      sessionId: 'missing-session',
      error: 'Session not found: missing-session',
    });
  });

  it('correlates an error when writing to a session that does not exist', async () => {
    server = await startTestServer();
    const client = await server.connect();
    const from = client.mark();

    client.send({
      type: 'data',
      sessionId: 'missing-session',
      data: 'echo should-not-run\n',
      requestId: 'missing-data-request',
    });

    await expect(
      client.waitFor(
        (message) => message.requestId === 'missing-data-request',
        { from },
      ),
    ).resolves.toMatchObject({
      type: 'error',
      requestId: 'missing-data-request',
      sessionId: 'missing-session',
      error: 'Session not found: missing-session',
    });
  });

  it('reports idle-timeout closure consistently before removing a session', async () => {
    server = await startTestServer({
      idleTimeout: 50,
      cleanupInterval: 10,
    });
    const client = await server.connect();
    const session = await spawnSession(client);
    const from = client.mark();

    const closed = await client.waitForType('sessionClosed', {
      from,
      timeout: 2_000,
    });

    expect(closed).toMatchObject({
      type: 'sessionClosed',
      sessionId: session.id,
      reason: 'idle_timeout',
    });
    expect(client.messages.slice(from)).toContainEqual(
      expect.objectContaining({
        type: 'exit',
        sessionId: session.id,
        exitCode: -1,
      }),
    );
    await waitUntil(() => server!.terminal.getStats().sessionCount === 0, {
      description: 'idle PTY session to be removed',
    });
  });
});
