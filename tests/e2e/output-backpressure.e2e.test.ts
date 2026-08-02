import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { startTestServer, type StartedTestServer } from './protocol-harness.js';

describe('TerminalServer outbound backpressure (black-box)', () => {
  let server: StartedTestServer | undefined;

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
  });

  it('closes a client when even a direct protocol response exceeds its output ceiling', async () => {
    server = await startTestServer({ maxBufferedOutputBytes: 1 });
    const socket = new WebSocket(server.url);
    socket.on('error', () => undefined);

    const closed = await new Promise<{ code: number; reason: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('slow client was not disconnected')),
          2_000,
        );
        socket.once('close', (code, reason) => {
          clearTimeout(timer);
          resolve({ code, reason: reason.toString() });
        });
      },
    );

    expect(closed).toEqual({
      code: 1013,
      reason: 'Client output buffer limit exceeded',
    });
    expect(server.terminal.getStats()).toEqual({
      sessionCount: 0,
      clientCount: 0,
      orphanedCount: 0,
    });
  });
});
