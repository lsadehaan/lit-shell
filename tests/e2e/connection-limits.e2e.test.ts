import { afterEach, describe, expect, it } from 'vitest';

import {
  startTestServer,
  type ProtocolClient,
  type StartedTestServer,
} from './protocol-harness.js';

describe('TerminalServer connection-wide quotas (black-box)', () => {
  let server: StartedTestServer | undefined;

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
  });

  it('closes a connection after its total request count is exhausted', async () => {
    server = await startTestServer({ maxConnectionMessages: 2 });
    const client = await server.connect();
    await client.waitForType('serverInfo');
    const closed = captureClose(client);

    client.send({ requestId: 'first', type: 'listSessions' });
    client.send({ requestId: 'second', type: 'listSessions' });
    client.send({ requestId: 'third', type: 'listSessions' });

    await client.waitForClose();
    expect(await closed).toEqual({
      code: 1008,
      reason: 'Connection request limit exceeded',
    });
  });

  it('counts cumulative UTF-8 wire bytes independently of frame size', async () => {
    const request = JSON.stringify({
      padding: 'é'.repeat(16),
      type: 'unknown',
    });
    const requestBytes = Buffer.byteLength(request);
    server = await startTestServer({
      maxConnectionBytes: requestBytes * 2 - 1,
      maxMessageBytes: requestBytes + 1,
    });
    const client = await server.connect();
    await client.waitForType('serverInfo');
    const closed = captureClose(client);

    client.sendRaw(request);
    client.sendRaw(request);

    await client.waitForClose();
    expect(await closed).toEqual({
      code: 1008,
      reason: 'Connection request limit exceeded',
    });
  });
});

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
