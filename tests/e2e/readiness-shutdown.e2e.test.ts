import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { spawnSession } from './protocol-assertions.js';
import {
  expectConnectionRejected,
  startTestServer,
  testEnvironment,
  type StartedTestServer,
  waitUntil,
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

  it('serves concurrent cold-start requests after PTY initialization', async () => {
    let authorizationCalls = 0;
    let releaseAuthorization!: () => void;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const coldStartServer = await startTestServer({
      authorize: async () => {
        authorizationCalls += 1;
        await authorizationGate;
        return true;
      },
    });
    server = coldStartServer;

    const connectAndSpawn = () =>
      coldStartServer.connect((client) => {
        client.send({
          type: 'spawn',
          options: {
            shell: '/bin/sh',
            cwd: process.cwd(),
            env: testEnvironment(),
          },
        });
      });
    const [first, second] = await Promise.all([
      connectAndSpawn(),
      connectAndSpawn(),
    ]);

    await waitUntil(() => authorizationCalls === 2, {
      description: 'both cold-start authorization hooks',
    });
    releaseAuthorization();

    const [firstSpawned, secondSpawned] = await Promise.all([
      first.waitForType('spawned'),
      second.waitForType('spawned'),
    ]);
    expect(firstSpawned.sessionId).toEqual(expect.any(String));
    expect(secondSpawned.sessionId).toEqual(expect.any(String));
    expect(firstSpawned.sessionId).not.toBe(secondSpawned.sessionId);
    expect(coldStartServer.terminal.getStats()).toMatchObject({
      sessionCount: 2,
      clientCount: 2,
    });
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
