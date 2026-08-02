import { afterEach, describe, expect, it } from 'vitest';

import { startTestServer, type StartedTestServer } from './protocol-harness.js';

describe('TerminalServer session-sharing policy (black-box)', () => {
  let server: StartedTestServer | undefined;

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
  });

  it('rejects joinable sessions while accepting an explicitly private spawn', async () => {
    server = await startTestServer({ allowSessionSharing: false });
    const client = await server.connect();
    const rejectedFrom = client.mark();
    client.send({
      type: 'spawn',
      requestId: 'shared',
      options: { allowJoin: true },
    });

    await expect(
      client.waitForType('error', { from: rejectedFrom }),
    ).resolves.toMatchObject({
      error: 'Session sharing is disabled by server policy',
      requestId: 'shared',
    });
    expect(server.terminal.getStats().sessionCount).toBe(0);

    const privateFrom = client.mark();
    client.send({
      type: 'spawn',
      requestId: 'private',
      options: { allowJoin: false },
    });
    await expect(
      client.waitForType('spawned', { from: privateFrom }),
    ).resolves.toMatchObject({ requestId: 'private' });
  });
});
