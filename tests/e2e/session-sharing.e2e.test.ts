import { randomUUID } from 'node:crypto';

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
  type StartedTestServer,
} from './protocol-harness.js';

describe('TerminalServer session sharing (black-box)', () => {
  let server: StartedTestServer | undefined;

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
  });

  it('lists a shareable session with stable public metadata', async () => {
    server = await startTestServer();
    const owner = await server.connect();
    const observer = await server.connect();
    const session = await spawnSession(owner, {
      label: 'pairing-shell',
      allowJoin: true,
      enableHistory: true,
    });
    const from = observer.mark();

    observer.send({ type: 'listSessions' });

    const response = await observer.waitForType('sessionList', { from });
    expect(response.sessions).toEqual(expect.any(Array));
    const listed = (response.sessions as Record<string, unknown>[]).find(
      (candidate) => candidate.sessionId === session.id,
    );
    expect(listed).toMatchObject({
      sessionId: session.id,
      type: 'local',
      shell: '/bin/sh',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      clientCount: 1,
      accepting: true,
      label: 'pairing-shell',
      historyEnabled: true,
    });
    expect(typeof listed?.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(listed?.createdAt as string))).toBe(false);
  });

  it('keeps default sessions private while allowing the owner to resume with its capability', async () => {
    server = await startTestServer();
    const owner = await server.connect();
    const observer = await server.connect();
    const session = await spawnSession(owner, { label: 'private-default' });
    const resumeToken = session.message.resumeToken;
    expect(resumeToken).toEqual(expect.any(String));

    const observerListFrom = observer.mark();
    observer.send({ type: 'listSessions' });
    const observerList = await observer.waitForType('sessionList', {
      from: observerListFrom,
    });
    expect(observerList.sessions).toEqual([]);

    const ownerListFrom = owner.mark();
    owner.send({ type: 'listSessions' });
    const ownerList = await owner.waitForType('sessionList', {
      from: ownerListFrom,
    });
    expect(ownerList.sessions).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        accepting: false,
        label: 'private-default',
      }),
    ]);
    expect(JSON.stringify(ownerList.sessions)).not.toContain(
      resumeToken as string,
    );

    const rejectedFrom = observer.mark();
    observer.send({
      type: 'join',
      options: { sessionId: session.id, requestHistory: true },
    });
    await expectProtocolError(observer, rejectedFrom);

    await owner.close();
    const resumedOwner = await server.connect();
    const resumeFrom = resumedOwner.mark();
    resumedOwner.send({
      type: 'join',
      options: {
        sessionId: session.id,
        requestHistory: true,
        resumeToken,
      },
    });
    const joined = await resumedOwner.waitForType('joined', {
      from: resumeFrom,
    });
    expect(joined).toMatchObject({
      sessionId: session.id,
      resumeToken,
      session: { accepting: false },
    });
  });

  it('replays requested history and broadcasts subsequent output to all members', async () => {
    server = await startTestServer();
    const owner = await server.connect();
    const participant = await server.connect();
    const session = await spawnSession(owner, {
      label: 'shared',
      allowJoin: true,
    });
    await makeShellQuiet(owner, session);
    const historyMarker = `HISTORY_${randomUUID()}`;
    const historyFrom = owner.mark();
    owner.send({
      type: 'data',
      sessionId: session.id,
      data: printCommand(historyMarker),
    });
    await owner.waitForOutput(historyMarker, {
      sessionId: session.id,
      from: historyFrom,
    });
    const ownerJoinFrom = owner.mark();
    const participantJoinFrom = participant.mark();

    participant.send({
      type: 'join',
      options: {
        sessionId: session.id,
        requestHistory: true,
        historyLimit: 4_096,
      },
    });

    const joined = await participant.waitForType('joined', {
      from: participantJoinFrom,
    });
    expect(joined).toMatchObject({
      type: 'joined',
      sessionId: session.id,
    });
    expect(joined.history).toEqual(expect.any(String));
    expect(joined.history as string).toContain(historyMarker);
    expect(joined.session).toMatchObject({
      sessionId: session.id,
      clientCount: 2,
    });
    await expect(
      owner.waitFor(
        (message) =>
          message.type === 'clientJoined' && message.sessionId === session.id,
        { from: ownerJoinFrom },
      ),
    ).resolves.toMatchObject({ clientCount: 2 });

    const ownerMarker = `OWNER_LIVE_${randomUUID()}`;
    const ownerFrom = owner.mark();
    const participantFrom = participant.mark();
    owner.send({
      type: 'data',
      sessionId: session.id,
      data: printCommand(ownerMarker),
    });
    await Promise.all([
      owner.waitForOutput(ownerMarker, {
        sessionId: session.id,
        from: ownerFrom,
      }),
      participant.waitForOutput(ownerMarker, {
        sessionId: session.id,
        from: participantFrom,
      }),
    ]);

    const participantMarker = `PARTICIPANT_LIVE_${randomUUID()}`;
    const ownerReplyFrom = owner.mark();
    const participantReplyFrom = participant.mark();
    participant.send({
      type: 'data',
      sessionId: session.id,
      data: printCommand(participantMarker),
    });
    await Promise.all([
      owner.waitForOutput(participantMarker, {
        sessionId: session.id,
        from: ownerReplyFrom,
      }),
      participant.waitForOutput(participantMarker, {
        sessionId: session.id,
        from: participantReplyFrom,
      }),
    ]);
  });

  it('honors historyLimit as a maximum character count', async () => {
    server = await startTestServer({ historySize: 4_096 });
    const owner = await server.connect();
    const participant = await server.connect();
    const session = await spawnSession(owner, { allowJoin: true });
    await makeShellQuiet(owner, session);
    const tail = `TAIL_${randomUUID().slice(0, 8)}`;
    const output = `${'x'.repeat(256)}${tail}`;
    const outputFrom = owner.mark();
    owner.send({
      type: 'data',
      sessionId: session.id,
      data: printCommand(output),
    });
    await owner.waitForOutput(tail, {
      sessionId: session.id,
      from: outputFrom,
    });
    const from = participant.mark();

    participant.send({
      type: 'join',
      options: {
        sessionId: session.id,
        requestHistory: true,
        historyLimit: 32,
      },
    });

    const joined = await participant.waitForType('joined', { from });
    expect(joined.history).toEqual(expect.any(String));
    expect((joined.history as string).length).toBeLessThanOrEqual(32);
    expect(joined.history as string).toContain(tail);
  });

  it('does not inject input into a PTY when a participant joins', async () => {
    server = await startTestServer();
    const owner = await server.connect();
    const participant = await server.connect();
    const session = await spawnSession(owner, { allowJoin: true });
    await makeShellQuiet(owner, session);
    const shouldRemainPending = `JOIN_MUST_NOT_EXECUTE_${randomUUID()}`;
    const ownerFrom = owner.mark();
    const participantFrom = participant.mark();

    // Deliberately omit the newline: a passive join must not submit this input.
    owner.send({
      type: 'data',
      sessionId: session.id,
      data: printCommand(shouldRemainPending).replace(/\n$/, ''),
    });
    participant.send({
      type: 'join',
      options: { sessionId: session.id, requestHistory: false },
    });
    await participant.waitForType('joined', { from: participantFrom });

    await Promise.all([
      owner.expectNoOutput(shouldRemainPending, {
        sessionId: session.id,
        from: ownerFrom,
        duration: 400,
      }),
      participant.expectNoOutput(shouldRemainPending, {
        sessionId: session.id,
        from: participantFrom,
        duration: 400,
      }),
    ]);

    // Clear the intentionally incomplete command before test cleanup.
    owner.send({ type: 'data', sessionId: session.id, data: '\u0003' });
  });

  it('detaches a leaving participant without terminating the shared session', async () => {
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
    const ownerLeaveFrom = owner.mark();
    const participantLeaveFrom = participant.mark();

    participant.send({ type: 'leave', sessionId: session.id });

    await expect(
      participant.waitForType('left', { from: participantLeaveFrom }),
    ).resolves.toMatchObject({ sessionId: session.id });
    await expect(
      owner.waitForType('clientLeft', { from: ownerLeaveFrom }),
    ).resolves.toMatchObject({ sessionId: session.id, clientCount: 1 });
    expect(server.terminal.getStats()).toMatchObject({
      sessionCount: 1,
      clientCount: 1,
    });

    const marker = `AFTER_LEAVE_${randomUUID()}`;
    const ownerFrom = owner.mark();
    const participantFrom = participant.mark();
    participant.send({
      type: 'data',
      sessionId: session.id,
      data: printCommand(marker),
    });
    await expectProtocolError(participant, participantFrom);
    await owner.expectNoOutput(marker, {
      sessionId: session.id,
      from: ownerFrom,
    });

    const ownerMarker = `OWNER_CONTINUES_${randomUUID()}`;
    const liveFrom = owner.mark();
    owner.send({
      type: 'data',
      sessionId: session.id,
      data: printCommand(ownerMarker),
    });
    await owner.waitForOutput(ownerMarker, {
      sessionId: session.id,
      from: liveFrom,
    });
    await participant.expectNoOutput(ownerMarker, {
      sessionId: session.id,
      from: participantFrom,
    });
  });

  it('rejects joining an unknown session without breaking the connection', async () => {
    server = await startTestServer();
    const client = await server.connect();
    const from = client.mark();

    client.send({
      type: 'join',
      options: { sessionId: `missing-${randomUUID()}`, requestHistory: true },
    });

    await expectProtocolError(client, from);
    await expectConnectionUsable(client);
  });

  it('applies public list filters without exposing non-matching sessions', async () => {
    server = await startTestServer();
    const shareableOwner = await server.connect();
    const privateOwner = await server.connect();
    const observer = await server.connect();
    const shareable = await spawnSession(shareableOwner, {
      allowJoin: true,
      label: 'shareable',
    });
    await spawnSession(privateOwner, { label: 'private' });
    const from = observer.mark();

    observer.send({ type: 'listSessions', filter: { accepting: true } });

    const response = await observer.waitForType('sessionList', { from });
    const sessions = response.sessions as Record<string, unknown>[];
    expect(sessions.map((item) => item.sessionId)).toEqual([shareable.id]);
    expect(sessions.every((item) => item.accepting === true)).toBe(true);
  });
});
