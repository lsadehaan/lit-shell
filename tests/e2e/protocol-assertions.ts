import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import {
  testEnvironment,
  type ProtocolClient,
  type WireMessage,
} from './protocol-harness.js';

export interface SpawnedSession {
  id: string;
  readyMarker: string;
  message: WireMessage;
}

export async function spawnSession(
  client: ProtocolClient,
  options: Record<string, unknown> = {},
): Promise<SpawnedSession> {
  const readyMarker = `LIT_SHELL_READY_${randomUUID()}`;
  const suppliedEnvironment =
    options.env &&
    typeof options.env === 'object' &&
    !Array.isArray(options.env)
      ? (options.env as Record<string, string>)
      : {};
  const from = client.mark();

  client.send({
    type: 'spawn',
    options: {
      shell: '/bin/sh',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      ...options,
      env: testEnvironment({
        ...suppliedEnvironment,
        LIT_SHELL_E2E_READY: readyMarker,
      }),
    },
  });

  const message = await client.waitForType('spawned', { from });
  expect(message.sessionId).toEqual(expect.any(String));
  expect(message.sessionId).not.toBe('');
  expect(message.shell).toBe(options.shell ?? '/bin/sh');
  expect(message.cwd).toBe(options.cwd ?? process.cwd());
  expect(message.cols).toBe(options.cols ?? 80);
  expect(message.rows).toBe(options.rows ?? 24);

  return {
    id: message.sessionId as string,
    readyMarker,
    message,
  };
}

export async function makeShellQuiet(
  client: ProtocolClient,
  session: SpawnedSession,
): Promise<void> {
  const from = client.mark();
  client.send({
    type: 'data',
    sessionId: session.id,
    data: `stty -echo; printf '%s\\n' "$LIT_SHELL_E2E_READY"\n`,
  });
  await client.waitForOutput(session.readyMarker, {
    sessionId: session.id,
    from,
  });
}

export async function expectProtocolError(
  client: ProtocolClient,
  from: number,
): Promise<WireMessage> {
  // Rejections are synchronous protocol responses. Keeping this shorter than
  // PTY startup/output time makes a broken rejection fail fast in a ratchet run.
  const error = await client.waitForType('error', { from, timeout: 750 });
  expect(error.error).toEqual(expect.any(String));
  expect((error.error as string).trim()).not.toBe('');
  return error;
}

export async function expectConnectionUsable(
  client: ProtocolClient,
): Promise<void> {
  const from = client.mark();
  client.send({ type: 'listSessions' });
  const response = await client.waitForType('sessionList', { from });
  expect(response.sessions).toEqual(expect.any(Array));
}
