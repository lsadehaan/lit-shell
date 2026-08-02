import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type ClientOptions, type RawData } from 'ws';

import {
  startTestServer,
  type StartedTestServer,
  type WireMessage,
} from './protocol-harness.js';

interface ObservedSocket {
  readonly socket: WebSocket;
  readonly messages: WireMessage[];
  readonly opened: Promise<void>;
  readonly closed: Promise<{ code: number; reason: string }>;
}

function observeSocket(url: string, options?: ClientOptions): ObservedSocket {
  const socket = new WebSocket(url, options);
  const messages: WireMessage[] = [];
  socket.on('message', (data: RawData) => {
    const value = JSON.parse(data.toString()) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      messages.push(value as WireMessage);
    }
  });
  socket.on('error', () => undefined);

  return {
    socket,
    messages,
    opened: new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    }),
    closed: new Promise((resolve) => {
      socket.once('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    }),
  };
}

describe('WebSocket connection policy', () => {
  let server: StartedTestServer | undefined;

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
  });

  it.each([
    ['a foreign browser origin', { origin: 'https://attacker.example' }],
    ['a missing browser origin', undefined],
  ])('closes %s before exposing server metadata', async (_label, options) => {
    server = await startTestServer({
      allowedOrigins: ['https://terminal.example'],
    });
    const client = observeSocket(server.url, options);

    await client.opened;
    await expect(client.closed).resolves.toEqual({
      code: 1008,
      reason: 'Connection rejected by server policy',
    });
    expect(client.messages).toEqual([]);
  });

  it('accepts the exact configured browser origin', async () => {
    server = await startTestServer({
      allowedOrigins: ['https://terminal.example'],
    });
    const client = observeSocket(server.url, {
      origin: 'https://terminal.example',
    });

    await client.opened;
    await expect
      .poll(() =>
        client.messages.find((message) => message.type === 'serverInfo'),
      )
      .toMatchObject({ type: 'serverInfo' });

    client.socket.close();
    await client.closed;
  });

  it.each([
    ['returns false', () => false],
    ['throws', () => Promise.reject(new Error('private policy failure'))],
  ])('fails closed when authorize %s', async (_label, authorize) => {
    server = await startTestServer({ authorize });
    const client = observeSocket(server.url);

    await client.opened;
    await expect(client.closed).resolves.toEqual({
      code: 1008,
      reason: 'Connection rejected by server policy',
    });
    expect(client.messages).toEqual([]);
  });
});
