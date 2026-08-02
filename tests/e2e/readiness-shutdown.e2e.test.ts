import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { spawnSession } from './protocol-assertions.js';
import {
  expectConnectionRejected,
  startTestServer,
  testEnvironment,
  type StartedTestServer,
} from './protocol-harness.js';

describe('TerminalServer readiness and lifecycle (black-box)', () => {
  let server: StartedTestServer | undefined;

  afterEach(async () => {
    await server?.dispose();
    server = undefined;
  });

  it('accepts the very first request sent as soon as the WebSocket opens', async () => {
    server = await startTestServer();
    const readyMarker = `IMMEDIATE_${randomUUID()}`;

    const client = await server.connect((connected) => {
      connected.send({
        type: 'spawn',
        options: {
          shell: '/bin/sh',
          cwd: process.cwd(),
          cols: 91,
          rows: 27,
          env: testEnvironment({ LIT_SHELL_E2E_READY: readyMarker }),
        },
      });
    });

    const spawned = await client.waitForType('spawned');
    expect(spawned).toMatchObject({
      type: 'spawned',
      shell: '/bin/sh',
      cwd: process.cwd(),
      cols: 91,
      rows: 27,
    });
    expect(spawned.sessionId).toEqual(expect.any(String));
  });

  it('announces documented server capabilities on every connection', async () => {
    server = await startTestServer({
      allowedShells: ['/bin/sh'],
      defaultShell: '/bin/sh',
      allowDockerExec: false,
      defaultContainerShell: '/bin/ash',
    });

    const first = await server.connect();
    const second = await server.connect();
    const [firstInfo, secondInfo] = await Promise.all([
      first.waitForType('serverInfo'),
      second.waitForType('serverInfo'),
    ]);

    for (const message of [firstInfo, secondInfo]) {
      expect(message).toEqual({
        type: 'serverInfo',
        info: {
          localEnabled: true,
          dockerEnabled: false,
          allowedShells: ['/bin/sh'],
          defaultShell: '/bin/sh',
          defaultContainerShell: '/bin/ash',
        },
      });
    }
  });

  it('accepts WebSocket upgrades only on its configured endpoint', async () => {
    server = await startTestServer({ path: '/pty' });
    const client = await server.connect();
    await expect(client.waitForType('serverInfo')).resolves.toBeDefined();

    const wrongUrl = new URL(server.url);
    wrongUrl.pathname = '/not-the-terminal';
    await expectConnectionRejected(wrongUrl.toString());
  });

  it('closes active clients and PTYs when TerminalServer.close() is called', async () => {
    server = await startTestServer();
    const client = await server.connect();
    await spawnSession(client);
    expect(server.terminal.getStats()).toMatchObject({
      sessionCount: 1,
      clientCount: 1,
    });

    const socketClosed = client.waitForClose(1_000);
    server.terminal.close();

    expect(server.terminal.getStats()).toMatchObject({
      sessionCount: 0,
      clientCount: 0,
      orphanedCount: 0,
    });
    await socketClosed;
  });

  it('rejects new WebSocket connections after TerminalServer.close()', async () => {
    server = await startTestServer();
    const endpoint = server.url;

    server.terminal.close();

    await expectConnectionRejected(endpoint);
  });
});
