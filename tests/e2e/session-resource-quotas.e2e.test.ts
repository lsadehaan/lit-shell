import { afterEach, describe, expect, it } from 'vitest';

import { startTestServer, type StartedTestServer } from './protocol-harness.js';

describe('TerminalServer cumulative session quotas (black-box)', () => {
  let server: StartedTestServer | undefined;

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
  });

  it('counts UTF-8 input bytes and closes only after the configured limit', async () => {
    server = await startTestServer({ maxSessionInputBytes: 4 });
    const client = await server.connect();
    const spawned = await spawnWithDefaults(client);
    const from = client.mark();

    client.send({ type: 'data', sessionId: spawned, data: 'éé' });
    await client.expectNoOutput('input limit exceeded', {
      from,
      sessionId: spawned,
      duration: 100,
    });
    client.send({ type: 'data', sessionId: spawned, data: 'x' });

    await expect(
      client.waitFor(
        (message) =>
          message.type === 'sessionClosed' &&
          message.sessionId === spawned &&
          message.reason === 'input_limit',
        { from },
      ),
    ).resolves.toBeDefined();
    expect(server.terminal.getStats().sessionCount).toBe(0);
  });

  it('stops cumulative output before broadcasting the chunk that exceeds the cap', async () => {
    const maximum = 4_096;
    server = await startTestServer({ maxSessionOutputBytes: maximum });
    const client = await server.connect();
    const spawned = await spawnWithDefaults(client);
    const from = client.mark();

    client.send({
      type: 'data',
      sessionId: spawned,
      data: 'yes quota-flood\n',
    });

    await expect(
      client.waitFor(
        (message) =>
          message.type === 'sessionClosed' &&
          message.sessionId === spawned &&
          message.reason === 'output_limit',
        { from },
      ),
    ).resolves.toBeDefined();
    const outputBytes = client.messages
      .filter(
        (message) => message.type === 'data' && message.sessionId === spawned,
      )
      .reduce(
        (total, message) =>
          total + Buffer.byteLength(message.data as string, 'utf8'),
        0,
      );
    expect(outputBytes).toBeLessThanOrEqual(maximum);
    expect(server.terminal.getStats().sessionCount).toBe(0);
  });

  it('enforces an absolute lifetime even while the PTY remains active', async () => {
    server = await startTestServer({ maxSessionLifetime: 120 });
    const client = await server.connect();
    const spawned = await spawnWithDefaults(client);
    const from = client.mark();

    client.send({
      type: 'data',
      sessionId: spawned,
      data: 'while :; do printf x; sleep 0.01; done\n',
    });

    await client.waitForOutput('x', { from, sessionId: spawned });
    await expect(
      client.waitFor(
        (message) =>
          message.type === 'sessionClosed' &&
          message.sessionId === spawned &&
          message.reason === 'lifetime_timeout',
        { from },
      ),
    ).resolves.toBeDefined();
    expect(server.terminal.getStats().sessionCount).toBe(0);
  });

  it('can allow exactly one PTY creation over a WebSocket connection', async () => {
    server = await startTestServer({ maxSessionsCreatedPerConnection: 1 });
    const client = await server.connect();
    const spawned = await spawnWithDefaults(client);
    const closedFrom = client.mark();
    client.send({ type: 'close', sessionId: spawned });
    await client.waitFor(
      (message) =>
        message.type === 'sessionClosed' && message.sessionId === spawned,
      { from: closedFrom },
    );
    const secondFrom = client.mark();

    client.send({ type: 'spawn' });

    await expect(
      client.waitForType('error', { from: secondFrom }),
    ).resolves.toMatchObject({
      error: 'Connection session creation limit (1) reached',
    });
    expect(server.terminal.getStats().sessionCount).toBe(0);
  });
});

async function spawnWithDefaults(
  client: Awaited<ReturnType<StartedTestServer['connect']>>,
): Promise<string> {
  const from = client.mark();
  client.send({ type: 'spawn' });
  const spawned = await client.waitForType('spawned', { from });
  return spawned.sessionId as string;
}
