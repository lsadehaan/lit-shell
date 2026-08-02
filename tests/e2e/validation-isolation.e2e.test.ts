import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  expectConnectionUsable,
  expectProtocolError,
  makeShellQuiet,
  spawnSession,
} from './protocol-assertions.js';
import {
  printCommand,
  startTestServer,
  type ProtocolClient,
  type StartedTestServer,
} from './protocol-harness.js';

describe('TerminalServer protocol validation (black-box)', () => {
  let server: StartedTestServer | undefined;

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
  });

  it.each([
    ['invalid JSON', '{not-json'],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON number', '42'],
    ['an object with no type', '{}'],
    [
      'an unknown message type',
      JSON.stringify({ type: 'not-a-protocol-message' }),
    ],
  ])(
    'rejects %s and keeps the connection usable',
    async (_description, frame) => {
      server = await startTestServer();
      const client = await server.connect();
      const from = client.mark();

      client.sendRaw(frame);

      await expectProtocolError(client, from);
      await expectConnectionUsable(client);
    },
  );

  it.each([
    ['null spawn options', () => ({ type: 'spawn', options: null })],
    ['array spawn options', () => ({ type: 'spawn', options: [] })],
    ['a non-string shell', () => ({ type: 'spawn', options: { shell: 7 } })],
    ['a non-string cwd', () => ({ type: 'spawn', options: { cwd: false } })],
    ['zero columns', () => ({ type: 'spawn', options: { cols: 0 } })],
    ['negative rows', () => ({ type: 'spawn', options: { rows: -1 } })],
    ['oversized columns', () => ({ type: 'spawn', options: { cols: 1_001 } })],
    ['oversized rows', () => ({ type: 'spawn', options: { rows: 1_001 } })],
    [
      'an overflowing orphan timeout',
      () => ({
        type: 'spawn',
        options: { orphanTimeout: 2_147_483_648 },
      }),
    ],
  ])('rejects %s without creating a PTY', async (_description, message) => {
    server = await startTestServer();
    const client = await server.connect();
    const from = client.mark();

    client.send(message());

    await expectProtocolError(client, from);
    expect(server.terminal.getStats()).toMatchObject({
      sessionCount: 0,
      clientCount: 0,
    });
    await expectConnectionUsable(client);
  });

  it.each([
    [
      'data without a sessionId',
      (sessionId: string) => ({
        type: 'data',
        data: 'echo no\n',
        _sessionId: sessionId,
      }),
    ],
    [
      'non-string terminal data',
      (sessionId: string) => ({ type: 'data', sessionId, data: 42 }),
    ],
    [
      'resize without a sessionId',
      (sessionId: string) => ({
        type: 'resize',
        cols: 80,
        rows: 24,
        _sessionId: sessionId,
      }),
    ],
    [
      'zero resize columns',
      (sessionId: string) => ({ type: 'resize', sessionId, cols: 0, rows: 24 }),
    ],
    [
      'negative resize rows',
      (sessionId: string) => ({
        type: 'resize',
        sessionId,
        cols: 80,
        rows: -1,
      }),
    ],
    [
      'fractional resize dimensions',
      (sessionId: string) => ({
        type: 'resize',
        sessionId,
        cols: 80.5,
        rows: 24,
      }),
    ],
    [
      'oversized resize columns',
      (sessionId: string) => ({
        type: 'resize',
        sessionId,
        cols: 1_001,
        rows: 24,
      }),
    ],
    [
      'oversized resize rows',
      (sessionId: string) => ({
        type: 'resize',
        sessionId,
        cols: 80,
        rows: 1_001,
      }),
    ],
    [
      'close without a sessionId',
      (sessionId: string) => ({ type: 'close', _sessionId: sessionId }),
    ],
    [
      'leave without a sessionId',
      (sessionId: string) => ({ type: 'leave', _sessionId: sessionId }),
    ],
  ])(
    'rejects %s without damaging the active session',
    async (_description, message) => {
      server = await startTestServer();
      const client = await server.connect();
      const session = await spawnSession(client);
      const from = client.mark();

      client.send(message(session.id));

      await expectProtocolError(client, from);
      expect(server.terminal.getStats()).toMatchObject({
        sessionCount: 1,
        clientCount: 1,
      });
      await expectConnectionUsable(client);
    },
  );

  it('rejects history requests larger than the retained server history', async () => {
    server = await startTestServer({ historySize: 128 });
    const client = await server.connect();
    const from = client.mark();

    client.send({
      type: 'join',
      options: {
        sessionId: 'missing-session',
        requestHistory: true,
        historyLimit: Number.MAX_SAFE_INTEGER,
      },
    });

    const error = await expectProtocolError(client, from);
    expect(error.error).toMatch(/historyLimit/);
    await expectConnectionUsable(client);
  });
});

describe('TerminalServer session access isolation (black-box)', () => {
  let server: StartedTestServer | undefined;

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
  });

  async function ownerAndIntruder(): Promise<{
    owner: ProtocolClient;
    intruder: ProtocolClient;
    session: Awaited<ReturnType<typeof spawnSession>>;
  }> {
    server = await startTestServer();
    const owner = await server.connect();
    const intruder = await server.connect();
    const session = await spawnSession(owner, { allowJoin: true });
    await makeShellQuiet(owner, session);
    return { owner, intruder, session };
  }

  it('does not let an unjoined client write to a session it can name', async () => {
    const { owner, intruder, session } = await ownerAndIntruder();
    const marker = `INTRUDER_WRITE_${randomUUID()}`;
    const ownerFrom = owner.mark();
    const intruderFrom = intruder.mark();

    intruder.send({
      type: 'data',
      sessionId: session.id,
      data: printCommand(marker),
    });

    await expectProtocolError(intruder, intruderFrom);
    await owner.expectNoOutput(marker, {
      sessionId: session.id,
      from: ownerFrom,
    });
  });

  it('does not let an unjoined client resize another session', async () => {
    const { owner, intruder, session } = await ownerAndIntruder();
    const intruderFrom = intruder.mark();
    const ownerFrom = owner.mark();

    intruder.send({
      type: 'resize',
      sessionId: session.id,
      cols: 13,
      rows: 7,
    });
    await delay(50);
    owner.send({ type: 'data', sessionId: session.id, data: 'stty size\n' });

    const [error, output] = await Promise.all([
      expectProtocolError(intruder, intruderFrom),
      owner.waitForOutput(/(?:^|\r?\n)24 80(?:\r?\n|$)/, {
        sessionId: session.id,
        from: ownerFrom,
      }),
    ]);
    expect(
      error.sessionId === undefined || error.sessionId === session.id,
    ).toBe(true);
    expect(output).toMatch(/(?:^|\r?\n)24 80(?:\r?\n|$)/);
  });

  it('does not let an unjoined client close another session', async () => {
    const { owner, intruder, session } = await ownerAndIntruder();
    const intruderFrom = intruder.mark();

    intruder.send({ type: 'close', sessionId: session.id });

    await expectProtocolError(intruder, intruderFrom);
    expect(server!.terminal.getStats().sessionCount).toBe(1);
    const marker = `OWNER_SURVIVED_${randomUUID()}`;
    const ownerFrom = owner.mark();
    owner.send({
      type: 'data',
      sessionId: session.id,
      data: printCommand(marker),
    });
    await owner.waitForOutput(marker, {
      sessionId: session.id,
      from: ownerFrom,
    });
  });

  it("does not let a joined non-owner terminate everybody else's session", async () => {
    server = await startTestServer();
    const owner = await server.connect();
    const participant = await server.connect();
    const session = await spawnSession(owner, { allowJoin: true });
    await makeShellQuiet(owner, session);
    participant.send({
      type: 'join',
      options: { sessionId: session.id, requestHistory: false },
    });
    await participant.waitForType('joined');
    const from = participant.mark();

    participant.send({ type: 'close', sessionId: session.id });

    await expectProtocolError(participant, from);
    expect(server.terminal.getStats().sessionCount).toBe(1);
    const marker = `OWNER_STILL_RUNNING_${randomUUID()}`;
    const ownerFrom = owner.mark();
    owner.send({
      type: 'data',
      sessionId: session.id,
      data: printCommand(marker),
    });
    await owner.waitForOutput(marker, {
      sessionId: session.id,
      from: ownerFrom,
    });
  });

  it('does not leak output between independent sessions', async () => {
    server = await startTestServer();
    const first = await server.connect();
    const second = await server.connect();
    const firstSession = await spawnSession(first);
    const secondSession = await spawnSession(second);
    await makeShellQuiet(first, firstSession);
    await makeShellQuiet(second, secondSession);
    const marker = `ONLY_FIRST_${randomUUID()}`;
    const firstFrom = first.mark();
    const secondFrom = second.mark();

    first.send({
      type: 'data',
      sessionId: firstSession.id,
      data: printCommand(marker),
    });

    await first.waitForOutput(marker, {
      sessionId: firstSession.id,
      from: firstFrom,
    });
    await second.expectNoOutput(marker, { from: secondFrom });
  });

  it('keeps sessions private by default at the protocol boundary', async () => {
    server = await startTestServer();
    const owner = await server.connect();
    const intruder = await server.connect();
    const session = await spawnSession(owner);
    const from = intruder.mark();

    intruder.send({
      type: 'join',
      options: { sessionId: session.id, requestHistory: true },
    });

    await expectProtocolError(intruder, from);
    expect(server.terminal.getStats()).toMatchObject({
      sessionCount: 1,
      clientCount: 1,
    });
  });
});

describe('TerminalServer configured shell and path boundaries (black-box)', () => {
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

  it('rejects a different executable that merely has an allowed basename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lit-shell-e2e-shell-'));
    temporaryDirectories.push(root);
    const alternateShell = join(root, basename('/bin/sh'));
    await copyFile('/bin/sh', alternateShell);
    await chmod(alternateShell, 0o755);
    server = await startTestServer({ allowedShells: ['/bin/sh'] });
    const client = await server.connect();
    const from = client.mark();

    client.send({
      type: 'spawn',
      options: { shell: alternateShell, cwd: process.cwd() },
    });

    await expectProtocolError(client, from);
    expect(server.terminal.getStats().sessionCount).toBe(0);
  });

  it('rejects a sibling directory that only shares an allowed path prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lit-shell-e2e-path-prefix-'));
    temporaryDirectories.push(root);
    const allowed = join(root, 'workspace');
    const sibling = join(root, 'workspace-secrets');
    await Promise.all([mkdir(allowed), mkdir(sibling)]);
    server = await startTestServer({
      allowedPaths: [allowed],
      defaultCwd: allowed,
    });
    const client = await server.connect();
    const from = client.mark();

    client.send({
      type: 'spawn',
      options: { shell: '/bin/sh', cwd: sibling },
    });

    await expectProtocolError(client, from);
    expect(server.terminal.getStats().sessionCount).toBe(0);
  });

  it('rejects a working-directory symlink that escapes an allowed tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lit-shell-e2e-path-link-'));
    temporaryDirectories.push(root);
    const allowed = join(root, 'workspace');
    const outside = join(root, 'outside');
    const escape = join(allowed, 'escape');
    await Promise.all([mkdir(allowed), mkdir(outside)]);
    await symlink(outside, escape, 'dir');
    server = await startTestServer({
      allowedPaths: [allowed],
      defaultCwd: allowed,
    });
    const client = await server.connect();
    const from = client.mark();

    client.send({
      type: 'spawn',
      options: { shell: '/bin/sh', cwd: escape },
    });

    await expectProtocolError(client, from);
    expect(server.terminal.getStats().sessionCount).toBe(0);
  });
});
