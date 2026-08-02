import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
  startTestServer,
  type ProtocolClient,
  type StartedTestServer,
} from './protocol-harness.js';

interface DeferredAuthorization {
  authorize(): Promise<boolean>;
  allow(): void;
}

function deferredAuthorization(): DeferredAuthorization {
  let allow!: () => void;
  const result = new Promise<boolean>((resolve) => {
    allow = () => resolve(true);
  });
  return { authorize: () => result, allow };
}

function captureClose(client: ProtocolClient): Promise<{
  code: number;
  reason: string;
}> {
  return new Promise((resolve) => {
    client.socket.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

describe('TerminalServer pre-authorization limits (black-box)', () => {
  let server: StartedTestServer | undefined;
  let authorization: DeferredAuthorization | undefined;

  afterEach(async () => {
    authorization?.allow();
    await server?.dispose();
    server = undefined;
    authorization = undefined;
  });

  it('closes a client that queues too many frames before authorization', async () => {
    authorization = deferredAuthorization();
    server = await startTestServer({
      authorize: authorization.authorize,
      maxPreAuthMessages: 2,
      maxPreAuthBytes: 64 * 1024,
    });
    const client = await server.connect();
    const close = captureClose(client);

    client.send({ type: 'listSessions', requestId: 'queued-1' });
    client.send({ type: 'listSessions', requestId: 'queued-2' });
    client.send({ type: 'listSessions', requestId: 'queued-3' });

    await client.waitForClose(1_000);
    expect(await close).toMatchObject({
      code: 1008,
      reason: expect.stringMatching(/pre-authorization request limit/i),
    });
    expect(client.messages).not.toContainEqual(
      expect.objectContaining({ type: 'serverInfo' }),
    );
    expect(server.terminal.getStats()).toMatchObject({
      sessionCount: 0,
      clientCount: 0,
    });
  });

  it('closes a client that queues too many bytes before authorization', async () => {
    authorization = deferredAuthorization();
    server = await startTestServer({
      authorize: authorization.authorize,
      maxPreAuthMessages: 16,
      maxPreAuthBytes: 64,
    });
    const client = await server.connect();
    const close = captureClose(client);

    client.send({
      type: 'listSessions',
      requestId: 'oversized',
      padding: 'x'.repeat(256),
    });

    await client.waitForClose(1_000);
    expect(await close).toMatchObject({
      code: 1008,
      reason: expect.stringMatching(/pre-authorization request limit/i),
    });
    expect(client.messages).not.toContainEqual(
      expect.objectContaining({ type: 'serverInfo' }),
    );
    expect(server.terminal.getStats().sessionCount).toBe(0);
  });

  it('accepts frames at the configured boundary once authorization succeeds', async () => {
    authorization = deferredAuthorization();
    server = await startTestServer({
      authorize: authorization.authorize,
      maxPreAuthMessages: 2,
      maxPreAuthBytes: 64 * 1024,
    });
    const client = await server.connect();

    client.send({ type: 'listSessions', requestId: 'boundary-1' });
    client.send({ type: 'listSessions', requestId: 'boundary-2' });
    await delay(25);
    authorization.allow();

    const first = await client.waitFor(
      (message) => message.requestId === 'boundary-1',
    );
    const second = await client.waitFor(
      (message) => message.requestId === 'boundary-2',
    );
    expect(first).toMatchObject({ type: 'sessionList', sessions: [] });
    expect(second).toMatchObject({ type: 'sessionList', sessions: [] });
    expect(client.messages).toContainEqual(
      expect.objectContaining({ type: 'serverInfo' }),
    );
  });

  it('closes an oversized request even after the connection is ready', async () => {
    server = await startTestServer({ maxMessageBytes: 64 });
    const client = await server.connect();
    await client.waitForType('serverInfo');
    const close = captureClose(client);

    client.send({ type: 'listSessions', padding: 'x'.repeat(256) });

    await client.waitForClose(1_000);
    expect(await close).toMatchObject({ code: 1009 });
    expect(server.terminal.getStats()).toMatchObject({
      sessionCount: 0,
      clientCount: 0,
    });
  });
});
