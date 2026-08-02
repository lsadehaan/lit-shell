import { once } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { connect as connectTcp } from 'node:net';

import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRemoteDemoService,
  type RemoteDemoService,
} from '../../deploy/remote-shell/server.js';

const allowedOrigin = 'https://pages.test';

describe('remote demo gateway (black-box)', () => {
  let service: RemoteDemoService | undefined;

  afterEach(async () => {
    await service?.close();
    service = undefined;
    vi.restoreAllMocks();
  });

  it('exposes stable health and fail-closed anonymous admission HTTP boundaries', async () => {
    const started = await startService();
    const live = await fetch(`${started.origin}/health/live`);
    expect(live.status).toBe(200);
    expect(live.headers.get('cache-control')).toBe('no-store');
    await expect(live.json()).resolves.toEqual({
      revision: 'b'.repeat(40),
      status: 'live',
    });
    const readyWithCors = await fetch(`${started.origin}/health/ready`, {
      headers: { Origin: allowedOrigin },
    });
    expect(readyWithCors.headers.get('access-control-allow-origin')).toBe(
      allowedOrigin,
    );
    expect(readyWithCors.headers.get('access-control-expose-headers')).toBe(
      'Retry-After',
    );

    const wrongOrigin = await requestAdmission(started.origin, {
      origin: 'https://attacker.test',
    });
    expect(wrongOrigin.status).toBe(403);
    const body = await requestAdmission(started.origin, {
      body: 'not-empty',
      origin: allowedOrigin,
    });
    expect(body.status).toBe(413);

    const admission = await requestAdmission(started.origin, {
      origin: allowedOrigin,
    });
    expect(admission.status).toBe(201);
    expect(admission.headers.get('access-control-allow-origin')).toBe(
      allowedOrigin,
    );
    expect(admission.headers.get('access-control-expose-headers')).toBe(
      'Retry-After',
    );
    expect(admission.headers.get('cache-control')).toBe('no-store');
    const grant = (await admission.json()) as AdmissionResponse;
    expect(grant).toMatchObject({
      protocol: 'lit-shell.v1',
      sessionLifetimeMs: 60_000,
      webSocketPath: '/terminal',
    });
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const busy = await requestAdmission(started.origin, {
      origin: allowedOrigin,
    });
    expect(busy.status).toBe(429);
    expect(Number(busy.headers.get('retry-after'))).toBeGreaterThan(0);
    const ready = await fetch(`${started.origin}/health/ready`);
    await expect(ready.json()).resolves.toMatchObject({
      admission: 'reserved',
      status: 'ready',
    });
  });

  it('releases a consumed lease when ws rejects a malformed handshake', async () => {
    const started = await startService();
    const admission = await requestAdmission(started.origin, {
      origin: allowedOrigin,
    });
    const grant = (await admission.json()) as AdmissionResponse;

    const response = await sendMalformedUpgrade(started.origin, grant.token);
    expect(response).toMatch(/^HTTP\/1\.1 400 /u);

    const replacement = await requestAdmission(started.origin, {
      origin: allowedOrigin,
    });
    expect(replacement.status).toBe(201);
  });

  it('fails admissions closed while sandbox recovery is unhealthy', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    let preflightCalls = 0;
    service = await createRemoteDemoService({
      config: {
        allowedOrigin,
        buildRevision: 'b'.repeat(40),
        host: '127.0.0.1',
        launcherPath: '/bin/sh',
        port: 0,
      },
      preflight: () => {
        preflightCalls += 1;
        return preflightCalls === 1
          ? Promise.resolve()
          : Promise.reject(new Error('sandbox remains locked'));
      },
      sandboxRecoveryTimeoutMs: 20,
    });
    const started = await service.listen();
    const admission = await requestAdmission(started.origin, {
      origin: allowedOrigin,
    });
    const grant = (await admission.json()) as AdmissionResponse;
    const socket = new WebSocket(
      `${started.origin.replace('http:', 'ws:')}/terminal`,
      ['lit-shell.v1', `lit-shell.admission.${grant.token}`],
      { origin: allowedOrigin },
    );
    await once(socket, 'open');
    socket.close();
    await once(socket, 'close');

    const unavailable = await waitForStatus(
      () => requestAdmission(started.origin, { origin: allowedOrigin }),
      503,
    );
    await expect(unavailable.json()).resolves.toEqual({
      error: 'Sandbox is unavailable',
    });
    const ready = await fetch(`${started.origin}/health/ready`);
    expect(ready.status).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(preflightCalls).toBeGreaterThan(1);
    const afterRecoveryFailure = await requestAdmission(started.origin, {
      origin: allowedOrigin,
    });
    expect(afterRecoveryFailure.status).toBe(503);
    expect(errorLog).toHaveBeenCalledWith(
      '[remote-demo] sandbox cleanup verification failed:',
      'The sandbox did not recover after session cleanup',
    );
  });

  it('rejects unauthorized upgrades and enforces one gateway-owned PTY policy', async () => {
    const started = await startService();
    const admission = await requestAdmission(started.origin, {
      origin: allowedOrigin,
    });
    const grant = (await admission.json()) as AdmissionResponse;
    const websocketUrl = `${started.origin.replace('http:', 'ws:')}/terminal`;

    await expectUpgradeRejected(websocketUrl, ['lit-shell.v1'], 401);
    const socket = new WebSocket(
      websocketUrl,
      ['lit-shell.v1', `lit-shell.admission.${grant.token}`],
      { origin: allowedOrigin },
    );
    expect(socket.url).not.toContain(grant.token);
    const serverInfo = waitForMessage(
      socket,
      (message) => message.type === 'serverInfo',
    );
    await once(socket, 'open');
    expect(socket.protocol).toBe('lit-shell.v1');
    await serverInfo;

    socket.send(
      JSON.stringify({
        type: 'spawn',
        requestId: 'hostile-env',
        options: { env: { NODE_OPTIONS: '--require=/tmp/attack.js' } },
      }),
    );
    await expect(
      waitForMessage(socket, (message) => message.requestId === 'hostile-env'),
    ).resolves.toMatchObject({
      error: 'spawn option is disabled by server policy: env',
      type: 'error',
    });

    socket.send(
      JSON.stringify({
        type: 'spawn',
        requestId: 'hostile-sharing',
        options: { allowJoin: true },
      }),
    );
    await expect(
      waitForMessage(
        socket,
        (message) => message.requestId === 'hostile-sharing',
      ),
    ).resolves.toMatchObject({
      error: 'Session sharing is disabled by server policy',
      type: 'error',
    });

    socket.send(
      JSON.stringify({
        type: 'spawn',
        requestId: 'safe-spawn',
        options: { cols: 88, rows: 26 },
      }),
    );
    const spawned = await waitForMessage(
      socket,
      (message) => message.requestId === 'safe-spawn',
    );
    expect(spawned).toMatchObject({ cols: 88, rows: 26, type: 'spawned' });
    const sessionId = spawned.sessionId as string;
    socket.send(
      JSON.stringify({
        type: 'data',
        sessionId,
        data: "printf 'remote-gateway-ok\\n'\n",
      }),
    );
    await expect(
      waitForOutput(socket, sessionId, 'remote-gateway-ok'),
    ).resolves.toContain('remote-gateway-ok');

    socket.send(
      JSON.stringify({
        type: 'close',
        requestId: 'close-first',
        sessionId,
      }),
    );
    await waitForMessage(
      socket,
      (message) => message.requestId === 'close-first',
    );
    socket.send(JSON.stringify({ type: 'spawn', requestId: 'second-spawn' }));
    await expect(
      waitForMessage(socket, (message) => message.requestId === 'second-spawn'),
    ).resolves.toMatchObject({
      error: 'Connection session creation limit (1) reached',
      type: 'error',
    });

    socket.close();
    await once(socket, 'close');
    await expectUpgradeRejected(
      websocketUrl,
      ['lit-shell.v1', `lit-shell.admission.${grant.token}`],
      401,
    );
    const replacement = await requestAdmission(started.origin, {
      origin: allowedOrigin,
    });
    expect(replacement.status).toBe(201);
  });

  async function startService(): Promise<{ origin: string }> {
    service = await createRemoteDemoService({
      config: {
        allowedOrigin,
        buildRevision: 'b'.repeat(40),
        host: '127.0.0.1',
        launcherPath: '/bin/sh',
        port: 0,
      },
      preflight: () => Promise.resolve(),
    });
    return service.listen();
  }
});

interface AdmissionResponse {
  readonly protocol: string;
  readonly sessionLifetimeMs: number;
  readonly token: string;
  readonly webSocketPath: string;
}

function requestAdmission(
  origin: string,
  options: { body?: string; origin: string },
): Promise<Response> {
  return fetch(`${origin}/v1/admissions`, {
    body: options.body,
    headers: { Origin: options.origin },
    method: 'POST',
  });
}

function sendMalformedUpgrade(origin: string, token: string): Promise<string> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connectTcp({
      host: url.hostname,
      port: Number(url.port),
    });
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for malformed upgrade rejection'));
    }, 2_000);
    const finish = () => {
      clearTimeout(timer);
      resolve(response);
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('close', finish);
    socket.once('connect', () => {
      socket.write(
        [
          'GET /terminal HTTP/1.1',
          `Host: ${url.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 7',
          `Sec-WebSocket-Protocol: lit-shell.v1, lit-shell.admission.${token}`,
          `Origin: ${allowedOrigin}`,
          '',
          '',
        ].join('\r\n'),
      );
    });
  });
}

async function expectUpgradeRejected(
  url: string,
  protocols: string[],
  expectedStatus: number,
): Promise<void> {
  const socket = new WebSocket(url, protocols, { origin: allowedOrigin });
  socket.on('error', () => undefined);
  const [request, response] = (await once(socket, 'unexpected-response')) as [
    ClientRequest,
    IncomingMessage,
  ];
  expect(response.statusCode).toBe(expectedStatus);
  response.resume();
  request.destroy();
}

interface WireMessage {
  readonly [key: string]: unknown;
  readonly type?: string;
}

function waitForMessage(
  socket: WebSocket,
  predicate: (message: WireMessage) => boolean,
  timeout = 2_000,
): Promise<WireMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for a remote demo protocol message'));
    }, timeout);
    const onMessage = (data: WebSocket.RawData) => {
      const parsed = JSON.parse(data.toString()) as WireMessage;
      if (!predicate(parsed)) return;
      cleanup();
      resolve(parsed);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
    };
    socket.on('message', onMessage);
  });
}

function waitForOutput(
  socket: WebSocket,
  sessionId: string,
  expected: string,
  timeout = 2_000,
): Promise<string> {
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for output: ${output}`));
    }, timeout);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as WireMessage;
      if (
        message.type !== 'data' ||
        message.sessionId !== sessionId ||
        typeof message.data !== 'string'
      ) {
        return;
      }
      output += message.data;
      if (!output.includes(expected)) return;
      cleanup();
      resolve(output);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
    };
    socket.on('message', onMessage);
  });
}

async function waitForStatus(
  request: () => Promise<Response>,
  expectedStatus: number,
): Promise<Response> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const response = await request();
    if (response.status === expectedStatus) return response;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for HTTP ${String(expectedStatus)}`);
}
