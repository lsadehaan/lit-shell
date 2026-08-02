import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { connect as connectTcp } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REMOTE_DEMO_LIMITS,
  type RemoteDemoConfig,
} from '../../deploy/remote-shell/config.js';
import {
  createRemoteDemoService,
  type RemoteDemoService,
} from '../../deploy/remote-shell/server.js';
import {
  TurnstileUnavailableError,
  type TurnstileVerifier,
} from '../../deploy/remote-shell/turnstile.js';

const allowedOrigin = 'https://pages.test';
const buildRevision = 'b'.repeat(40);
const validCaptchaToken = 'browser-provided-turnstile-proof';

describe('remote demo gateway (black-box)', () => {
  let service: RemoteDemoService | undefined;
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'lit-shell-remote-e2e-'));
    await mkdir(join(workspacePath, 'tmp'));
  });

  afterEach(async () => {
    await service?.close();
    service = undefined;
    await rm(workspacePath, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  it.runIf(process.platform !== 'win32')(
    'reports a stable failure when the fixed guest identity transition cannot execute',
    async () => {
      await expect(
        createRemoteDemoService({
          config: remoteDemoConfig(workspacePath),
          resetEnvironment: async () => undefined,
          turnstileVerifier: verifierReturning(true),
        }),
      ).rejects.toMatchObject({
        cause: expect.any(Error),
        message: 'The fixed guest identity transition is unavailable',
      });
    },
  );

  it('publishes health metadata and accepts only the exact CAPTCHA form boundary', async () => {
    const verifier = verifierReturning(true);
    const started = await startService({ verifier });

    const live = await fetch(`${started.origin}/health/live`);
    expect(live.status).toBe(200);
    expectSecurityHeaders(live);
    await expect(live.json()).resolves.toEqual({
      epoch: 1,
      resetAt: expect.any(String),
      revision: buildRevision,
      status: 'live',
    });

    const readyWithCors = await fetch(`${started.origin}/health/ready`, {
      headers: { Origin: allowedOrigin },
    });
    expect(readyWithCors.status).toBe(200);
    expect(readyWithCors.headers.get('access-control-allow-origin')).toBe(
      allowedOrigin,
    );
    expect(readyWithCors.headers.get('access-control-expose-headers')).toBe(
      'Retry-After',
    );
    await expect(readyWithCors.json()).resolves.toEqual({
      admission: {
        active: 0,
        capacity: REMOTE_DEMO_LIMITS.admissionCapacity,
        pending: 0,
      },
      epoch: 1,
      resetAt: expect.any(String),
      revision: buildRevision,
      status: 'ready',
    });

    const wrongOrigin = await requestAdmission(started.origin, {
      origin: 'https://attacker.test',
    });
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.headers.get('access-control-allow-origin')).toBeNull();
    await expect(wrongOrigin.json()).resolves.toEqual({
      error: 'Origin is not allowed',
    });

    await expectAdmissionError(
      requestAdmission(started.origin, { contentType: undefined }),
      415,
      'Admission requires a form-encoded verification token',
    );
    await expectAdmissionError(
      requestAdmission(started.origin, {
        contentType: 'application/json',
      }),
      415,
      'Admission requires a form-encoded verification token',
    );
    await expectAdmissionError(
      requestAdmission(started.origin, { body: '' }),
      400,
      'Admission requires exactly one verification token',
    );
    await expectAdmissionError(
      requestAdmission(started.origin, {
        body: 'turnstileToken=one&turnstileToken=two',
      }),
      400,
      'Admission requires exactly one verification token',
    );
    await expectAdmissionError(
      requestAdmission(started.origin, {
        body: 'turnstileToken=proof&unexpected=value',
      }),
      400,
      'Admission requires exactly one verification token',
    );
    await expectAdmissionError(
      requestAdmission(started.origin, { body: 'turnstileToken=%20' }),
      400,
      'Verification token is malformed',
    );
    await expectAdmissionError(
      requestAdmission(started.origin, {
        body: `turnstileToken=${'x'.repeat(
          REMOTE_DEMO_LIMITS.maxAdmissionBodyBytes,
        )}`,
      }),
      413,
      'Admission request is too large',
    );
    expect(await sendOversizedChunkedAdmission(started.origin)).toMatch(
      /^HTTP\/1\.1 413 Payload Too Large\r\n/u,
    );
    expect(verifier.verify).not.toHaveBeenCalled();

    const admission = await requestAdmission(started.origin);
    expect(admission.status).toBe(201);
    expectSecurityHeaders(admission);
    expect(admission.headers.get('access-control-allow-origin')).toBe(
      allowedOrigin,
    );
    const grant = await admissionGrant(admission);
    expect(grant).toMatchObject({
      expiresAt: expect.any(String),
      protocol: 'lit-shell.v1',
      resetAt: expect.any(String),
      webSocketPath: '/terminal',
    });
    expect(grant.sessionLifetimeMs).toBeGreaterThan(290_000);
    expect(grant.sessionLifetimeMs).toBeLessThanOrEqual(
      REMOTE_DEMO_LIMITS.sessionLifetimeMs,
    );
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(verifier.verify).toHaveBeenCalledOnce();
    expect(verifier.verify).toHaveBeenCalledWith(validCaptchaToken);

    const unknownPath = await fetch(`${started.origin}/health/live?probe=1`);
    expect(unknownPath.status).toBe(404);
    await expect(unknownPath.json()).resolves.toEqual({ error: 'Not found' });
  });

  it('fails closed for rejected or unavailable CAPTCHA verification', async () => {
    const invalidVerifier = verifierReturning(false);
    const started = await startService({ verifier: invalidVerifier });

    await expectAdmissionError(
      requestAdmission(started.origin),
      403,
      'Human verification failed',
    );
    expect(invalidVerifier.verify).toHaveBeenCalledOnce();

    await service?.close();
    service = undefined;
    const unavailableVerifier = verifierUnavailable();
    const unavailableService = await startService({
      verifier: unavailableVerifier,
    });
    const unavailable = await requestAdmission(unavailableService.origin);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('retry-after')).toBe('5');
    await expect(unavailable.json()).resolves.toEqual({
      error: 'Human verification is temporarily unavailable',
    });
    expect(unavailableVerifier.verify).toHaveBeenCalledOnce();
  });

  it('bounds concurrent CAPTCHA verification without trusting forwarded client IPs', async () => {
    const checks = Array.from(
      { length: REMOTE_DEMO_LIMITS.maxConcurrentVerifications + 1 },
      () => deferred<boolean>(),
    );
    let verificationIndex = 0;
    const verifier: TurnstileVerifier & { verify: ReturnType<typeof vi.fn> } = {
      verify: vi.fn(
        () => checks[verificationIndex++]?.promise ?? Promise.resolve(false),
      ),
    };
    const started = await startService({ verifier });
    const pending = Array.from(
      { length: REMOTE_DEMO_LIMITS.maxConcurrentVerifications },
      (_, index) =>
        requestAdmission(started.origin, {
          forwardedFor: `198.51.100.${String(index + 1)}`,
        }),
    );
    await vi.waitFor(() => {
      expect(verifier.verify).toHaveBeenCalledTimes(
        REMOTE_DEMO_LIMITS.maxConcurrentVerifications,
      );
    });

    const blocked = await requestAdmission(started.origin, {
      forwardedFor: '203.0.113.250',
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('1');
    await expect(blocked.json()).resolves.toEqual({
      error: 'Too many verification attempts',
    });
    expect(verifier.verify).toHaveBeenCalledTimes(
      REMOTE_DEMO_LIMITS.maxConcurrentVerifications,
    );

    checks[0]!.resolve(false);
    await Promise.race(pending);
    const admittedPromise = requestAdmission(started.origin, {
      forwardedFor: 'spoofed.invalid',
    });
    await vi.waitFor(() => {
      expect(verifier.verify).toHaveBeenCalledTimes(
        REMOTE_DEMO_LIMITS.maxConcurrentVerifications + 1,
      );
    });
    expect(
      verifier.verify.mock.calls.every((arguments_) => arguments_.length === 1),
    ).toBe(true);
    checks.at(-1)!.resolve(true);
    const admitted = await admittedPromise;
    expect(admitted.status).toBe(201);

    for (const check of checks.slice(1, -1)) check.resolve(false);
    await Promise.all(pending);
  });

  it('bounds sequential proof abuse and recovers without trusting forwarded client IPs', async () => {
    let now = 1_000;
    const validAfterAbuse = 'valid-after-sequential-abuse';
    const verifier: TurnstileVerifier & { verify: ReturnType<typeof vi.fn> } = {
      verify: vi.fn((token: string) =>
        Promise.resolve(token === validAfterAbuse),
      ),
    };
    const started = await startService({ now: () => now, verifier });

    for (
      let attempt = 0;
      attempt < REMOTE_DEMO_LIMITS.maxVerificationBurst;
      attempt += 1
    ) {
      await expectAdmissionError(
        requestAdmission(started.origin, {
          body: new URLSearchParams({
            turnstileToken: `invalid-proof-${String(attempt)}`,
          }).toString(),
          forwardedFor: `192.0.2.${String(attempt + 1)}`,
        }),
        403,
        'Human verification failed',
      );
    }

    const throttled = await requestAdmission(started.origin, {
      forwardedFor: '198.51.100.199',
    });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe('1');
    await expect(throttled.json()).resolves.toEqual({
      error: 'Too many verification attempts',
    });
    expect(verifier.verify).toHaveBeenCalledTimes(
      REMOTE_DEMO_LIMITS.maxVerificationBurst,
    );

    now += REMOTE_DEMO_LIMITS.verificationRefillIntervalMs;
    const admitted = await requestAdmission(started.origin, {
      body: new URLSearchParams({
        turnstileToken: validAfterAbuse,
      }).toString(),
      forwardedFor: '198.51.100.200',
    });
    expect(admitted.status).toBe(201);
    expect(verifier.verify).toHaveBeenCalledTimes(
      REMOTE_DEMO_LIMITS.maxVerificationBurst + 1,
    );
    expect(
      verifier.verify.mock.calls.every((arguments_) => arguments_.length === 1),
    ).toBe(true);
  });

  it('releases CAPTCHA verification slots after verifier failures', async () => {
    const verifier: TurnstileVerifier & { verify: ReturnType<typeof vi.fn> } = {
      verify: vi
        .fn<() => Promise<boolean>>()
        .mockRejectedValueOnce(new TurnstileUnavailableError())
        .mockRejectedValueOnce(new TurnstileUnavailableError())
        .mockRejectedValueOnce(new TurnstileUnavailableError())
        .mockRejectedValueOnce(new TurnstileUnavailableError())
        .mockResolvedValueOnce(true),
    };
    const started = await startService({ verifier });

    for (
      let attempt = 0;
      attempt < REMOTE_DEMO_LIMITS.maxConcurrentVerifications;
      attempt += 1
    ) {
      await expectAdmissionError(
        requestAdmission(started.origin),
        503,
        'Human verification is temporarily unavailable',
      );
    }

    const recovered = await requestAdmission(started.origin);
    expect(recovered.status).toBe(201);
    expect(verifier.verify).toHaveBeenCalledTimes(
      REMOTE_DEMO_LIMITS.maxConcurrentVerifications + 1,
    );
  });

  it('keeps verification concurrency bounded across reset and rejects stale proofs', async () => {
    const checks = Array.from(
      { length: REMOTE_DEMO_LIMITS.maxConcurrentVerifications + 1 },
      () => deferred<boolean>(),
    );
    let verificationIndex = 0;
    const verifier: TurnstileVerifier & { verify: ReturnType<typeof vi.fn> } = {
      verify: vi.fn(
        () => checks[verificationIndex++]?.promise ?? Promise.resolve(false),
      ),
    };
    const started = await startService({ verifier });
    const oldEpochRequests = Array.from(
      { length: REMOTE_DEMO_LIMITS.maxConcurrentVerifications },
      () => requestAdmission(started.origin),
    );
    await vi.waitFor(() => {
      expect(verifier.verify).toHaveBeenCalledTimes(
        REMOTE_DEMO_LIMITS.maxConcurrentVerifications,
      );
    });

    await service?.resetNow();
    const blocked = await requestAdmission(started.origin);
    expect(blocked.status).toBe(429);
    expect(verifier.verify).toHaveBeenCalledTimes(
      REMOTE_DEMO_LIMITS.maxConcurrentVerifications,
    );

    checks[0]!.resolve(true);
    await expectAdmissionError(
      oldEpochRequests[0]!,
      503,
      'Shared environment reset during verification',
    );

    const freshRequest = requestAdmission(started.origin);
    await vi.waitFor(() => {
      expect(verifier.verify).toHaveBeenCalledTimes(
        REMOTE_DEMO_LIMITS.maxConcurrentVerifications + 1,
      );
    });
    checks.at(-1)!.resolve(true);
    expect((await freshRequest).status).toBe(201);

    for (const check of checks.slice(1, -1)) check.resolve(false);
    const staleResponses = await Promise.all(oldEpochRequests.slice(1));
    expect(staleResponses.map((response) => response.status)).toEqual([
      403, 403, 403,
    ]);
    for (const response of staleResponses) {
      await expect(response.json()).resolves.toEqual({
        error: 'Human verification failed',
      });
    }
  });

  it('treats admission tokens as one-use WebSocket capabilities', async () => {
    const started = await startService();
    const grant = await requestGrant(started.origin);
    const websocketUrl = terminalUrl(started.origin);
    const protocols = admissionProtocols(grant.token);

    await expectUpgradeRejected(websocketUrl, ['lit-shell.v1'], 401);
    await expectUpgradeRejected(websocketUrl, protocols, 403, {
      origin: 'https://attacker.test',
    });

    const socket = await connectTerminal(websocketUrl, grant.token);
    expect(socket.url).not.toContain(grant.token);
    expect(socket.protocol).toBe('lit-shell.v1');
    await expectUpgradeRejected(websocketUrl, protocols, 401);

    await closeSocket(socket);
    await expectUpgradeRejected(websocketUrl, protocols, 401);

    const replacement = await requestAdmission(started.origin);
    expect(replacement.status).toBe(201);
    expect((await admissionGrant(replacement)).token).not.toBe(grant.token);
  });

  it('runs simultaneous PTYs in the same writable shared directory', async () => {
    const started = await startService();
    const [firstGrant, secondGrant] = await Promise.all([
      requestGrant(started.origin),
      requestGrant(started.origin),
    ]);
    const websocketUrl = terminalUrl(started.origin);
    const [first, second] = await Promise.all([
      connectTerminal(websocketUrl, firstGrant.token),
      connectTerminal(websocketUrl, secondGrant.token),
    ]);

    const firstSession = await spawn(first, 'first-spawn');
    const secondSession = await spawn(second, 'second-spawn');
    expect(firstSession).not.toBe(secondSession);
    expect(service?.terminalServer.getStats()).toMatchObject({
      clientCount: 2,
      sessionCount: 2,
    });

    const sharedValue = 'visible-to-the-other-live-pty';
    const writerDone = waitForOutput(
      first,
      firstSession,
      'writer-finished\r\n',
    );
    first.send(
      JSON.stringify({
        type: 'data',
        sessionId: firstSession,
        data:
          `stty -echo; printf '${sharedValue}\\n' > shared.txt; ` +
          "printf 'writer-finished\\n'\n",
      }),
    );
    await writerDone;

    const sharedOutput = waitForOutput(
      second,
      secondSession,
      'reader-finished\r\n',
    );
    second.send(
      JSON.stringify({
        type: 'data',
        sessionId: secondSession,
        data: "stty -echo; cat shared.txt; printf 'reader-finished\\n'\n",
      }),
    );
    await expect(sharedOutput).resolves.toContain(sharedValue);

    await Promise.all([closeSocket(first), closeSocket(second)]);
  });

  it('keeps identity, shell, cwd, and environment under server control', async () => {
    const hostSecretName = 'LIT_SHELL_E2E_HOST_SECRET';
    const hostSecretValue = 'host-value-that-must-not-reach-the-guest';
    const previousSecret = process.env[hostSecretName];
    process.env[hostSecretName] = hostSecretValue;
    let started: { origin: string };
    try {
      started = await startService();
    } finally {
      if (previousSecret === undefined) delete process.env[hostSecretName];
      else process.env[hostSecretName] = previousSecret;
    }

    const grant = await requestGrant(started.origin);
    const socket = await connectTerminal(
      terminalUrl(started.origin),
      grant.token,
    );
    const hostileOptions: Array<[string, unknown, string]> = [
      [
        'shell',
        '/bin/bash',
        'spawn option is disabled by server policy: shell',
      ],
      ['cwd', '/tmp', 'spawn option is disabled by server policy: cwd'],
      [
        'env',
        { NODE_OPTIONS: '--require=/tmp/attack.js' },
        'spawn option is disabled by server policy: env',
      ],
      ['label', 'public', 'spawn option is disabled by server policy: label'],
      [
        'enableHistory',
        true,
        'spawn option is disabled by server policy: enableHistory',
      ],
      [
        'orphanTimeout',
        2_147_483_647,
        'spawn option is disabled by server policy: orphanTimeout',
      ],
      ['allowJoin', true, 'Session sharing is disabled by server policy'],
      ['localUid', 0, 'spawn options contains unknown key: localUid'],
      ['localGid', 0, 'spawn options contains unknown key: localGid'],
    ];
    for (const [name, value, expectedError] of hostileOptions) {
      const requestId = `hostile-${name}`;
      const response = waitForMessage(
        socket,
        (message) => message.requestId === requestId,
      );
      socket.send(
        JSON.stringify({
          type: 'spawn',
          requestId,
          options: { [name]: value },
        }),
      );
      await expect(response).resolves.toMatchObject({
        error: expectedError,
        requestId,
        type: 'error',
      });
    }
    expect(service?.terminalServer.getStats()).toMatchObject({
      sessionCount: 0,
    });

    const sessionId = await spawn(socket, 'safe-spawn', {
      cols: 88,
      rows: 26,
    });
    const spawnedStats = service?.terminalServer.getStats();
    expect(spawnedStats).toMatchObject({ clientCount: 1, sessionCount: 1 });
    const environment = waitForOutput(
      socket,
      sessionId,
      'policy-check-finished\r\n',
    );
    socket.send(
      JSON.stringify({
        type: 'data',
        sessionId,
        data: [
          'stty -echo',
          'printf \'pwd=%s\\n\' "$PWD"',
          'printf \'home=%s\\n\' "$HOME"',
          'printf \'tmp=%s\\n\' "$TMPDIR"',
          'printf \'shell=%s\\n\' "$SHELL"',
          'printf \'uid=%s gid=%s\\n\' "$(id -u)" "$(id -g)"',
          'env',
          "printf 'policy-check-finished\\n'",
          '',
        ].join('\n'),
      }),
    );
    const output = await environment;
    expect(output).toContain(`pwd=${workspacePath}`);
    expect(output).toContain(`home=${workspacePath}`);
    expect(output).toContain(`tmp=${join(workspacePath, 'tmp')}`);
    expect(output).toContain('shell=/bin/sh');
    expect(output).toContain(
      `uid=${String(currentUid())} gid=${String(currentGid())}`,
    );
    expect(output).not.toContain(hostSecretValue);

    const secondSpawn = waitForMessage(
      socket,
      (message) => message.requestId === 'second-spawn',
    );
    socket.send(JSON.stringify({ type: 'spawn', requestId: 'second-spawn' }));
    await expect(secondSpawn).resolves.toMatchObject({
      error: 'Connection session creation limit (1) reached',
      type: 'error',
    });
  });

  it('enforces the advertised admission and active-session capacity', async () => {
    const started = await startService();
    const grants: AdmissionResponse[] = [];
    for (
      let index = 0;
      index < REMOTE_DEMO_LIMITS.admissionCapacity;
      index += 1
    ) {
      grants.push(await requestGrant(started.origin));
    }

    const pendingReady = await fetch(`${started.origin}/health/ready`);
    await expect(pendingReady.json()).resolves.toMatchObject({
      admission: {
        active: 0,
        capacity: REMOTE_DEMO_LIMITS.admissionCapacity,
        pending: REMOTE_DEMO_LIMITS.admissionCapacity,
      },
      status: 'ready',
    });

    const full = await requestAdmission(started.origin);
    expect(full.status).toBe(429);
    expect(Number(full.headers.get('retry-after'))).toBeGreaterThan(0);
    await expect(full.json()).resolves.toEqual({
      error: 'The remote demo is currently busy',
    });

    const sockets = await Promise.all(
      grants.map((grant) =>
        connectTerminal(terminalUrl(started.origin), grant.token),
      ),
    );
    await Promise.all(
      sockets.map((socket, index) =>
        spawn(socket, `capacity-spawn-${String(index)}`),
      ),
    );
    expect(service?.terminalServer.getStats()).toMatchObject({
      clientCount: REMOTE_DEMO_LIMITS.admissionCapacity,
      sessionCount: REMOTE_DEMO_LIMITS.admissionCapacity,
    });
    const activeReady = await fetch(`${started.origin}/health/ready`);
    await expect(activeReady.json()).resolves.toMatchObject({
      admission: {
        active: REMOTE_DEMO_LIMITS.admissionCapacity,
        capacity: REMOTE_DEMO_LIMITS.admissionCapacity,
        pending: 0,
      },
    });

    await Promise.all(sockets.map((socket) => closeSocket(socket)));
  });

  it('releases a consumed lease when WebSocket rejects a malformed handshake', async () => {
    const started = await startService();
    const grants: AdmissionResponse[] = [];
    for (
      let index = 0;
      index < REMOTE_DEMO_LIMITS.admissionCapacity;
      index += 1
    ) {
      grants.push(await requestGrant(started.origin));
    }

    const response = await sendMalformedUpgrade(
      started.origin,
      grants[0]?.token ?? '',
    );
    expect(response).toMatch(/^HTTP\/1\.1 400 /u);

    const afterMalformed = await fetch(`${started.origin}/health/ready`);
    await expect(afterMalformed.json()).resolves.toMatchObject({
      admission: {
        active: 0,
        pending: REMOTE_DEMO_LIMITS.admissionCapacity - 1,
      },
    });
    const replacement = await requestAdmission(started.origin);
    expect(replacement.status).toBe(201);
  });

  it('automatically advances the shared epoch on the global reset schedule', async () => {
    const resetEnvironment = vi.fn(async () => undefined);
    const started = await startService({
      resetEnvironment,
      resetIntervalMs: 250,
    });
    expect(resetEnvironment).not.toHaveBeenCalled();

    await vi.waitFor(
      async () => {
        const response = await fetch(`${started.origin}/health/ready`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
          epoch: expect.any(Number),
          status: 'ready',
        });
        expect(body.epoch).toBeGreaterThanOrEqual(2);
      },
      { interval: 25, timeout: 2_000 },
    );
    expect(resetEnvironment).toHaveBeenCalled();
  });

  it('resets an epoch by closing clients, clearing grants, and rebuilding before readiness', async () => {
    const resetStarted = deferred<void>();
    const releaseReset = deferred<void>();
    const resetEnvironment = vi.fn(async () => {
      resetStarted.resolve();
      await releaseReset.promise;
    });
    const started = await startService({ resetEnvironment });
    const activeGrant = await requestGrant(started.origin);
    const stalePendingGrant = await requestGrant(started.origin);
    const socket = await connectTerminal(
      terminalUrl(started.origin),
      activeGrant.token,
    );
    const sessionId = await spawn(socket, 'before-reset');
    expect(sessionId).toEqual(expect.any(String));
    const originalTerminalServer = service?.terminalServer;
    const socketClosed = once(socket, 'close');

    const reset = service?.resetNow();
    await resetStarted.promise;

    const duringReset = await fetch(`${started.origin}/health/ready`);
    expect(duringReset.status).toBe(503);
    await expect(duringReset.json()).resolves.toMatchObject({
      epoch: 1,
      status: 'resetting',
    });
    const blockedAdmission = await requestAdmission(started.origin);
    expect(blockedAdmission.status).toBe(503);
    expect(blockedAdmission.headers.get('retry-after')).toBe('2');
    await expect(blockedAdmission.json()).resolves.toEqual({
      error: 'Shared environment is resetting',
    });

    releaseReset.resolve();
    await reset;
    const [closeCode, closeReason] = (await socketClosed) as [number, Buffer];
    expect(closeCode).toBe(1012);
    expect(closeReason.toString()).toBe('Shared demo reset');
    expect(resetEnvironment).toHaveBeenCalledOnce();
    expect(service?.terminalServer).not.toBe(originalTerminalServer);

    const ready = await fetch(`${started.origin}/health/ready`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      admission: {
        active: 0,
        capacity: REMOTE_DEMO_LIMITS.admissionCapacity,
        pending: 0,
      },
      epoch: 2,
      status: 'ready',
    });
    await expectUpgradeRejected(
      terminalUrl(started.origin),
      admissionProtocols(stalePendingGrant.token),
      401,
    );
    const freshGrant = await requestAdmission(started.origin);
    expect(freshGrant.status).toBe(201);
  });

  it('ignores a hostile frame sent after the reset close frame', async () => {
    const resetStarted = deferred<void>();
    const releaseReset = deferred<void>();
    const started = await startService({
      resetEnvironment: async () => {
        resetStarted.resolve();
        await releaseReset.promise;
      },
    });
    const grant = await requestGrant(started.origin);
    const socket = await connectRawTerminal(started.origin, grant.token);
    const originalTerminalServer = service?.terminalServer;
    expect(originalTerminalServer).toBeDefined();

    const lateFrameWritten = deferred<void>();
    socket.once('data', () => {
      socket.write(
        maskedTextFrame(
          JSON.stringify({ requestId: 'after-reset', type: 'spawn' }),
        ),
        () => lateFrameWritten.resolve(),
      );
    });

    const reset = service?.resetNow();
    await resetStarted.promise;
    await lateFrameWritten.promise;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(originalTerminalServer?.getStats().sessionCount).toBe(0);

    releaseReset.resolve();
    await reset;
    socket.destroy();
    expect(service?.terminalServer.getStats().sessionCount).toBe(0);
  });

  async function startService(
    options: StartServiceOptions = {},
  ): Promise<{ origin: string }> {
    service = await createRemoteDemoService({
      config: remoteDemoConfig(workspacePath),
      now: options.now,
      prepareEnvironment: async () => undefined,
      resetEnvironment: options.resetEnvironment ?? (async () => undefined),
      resetIntervalMs: options.resetIntervalMs,
      turnstileVerifier: options.verifier ?? verifierReturning(true),
    });
    return service.listen();
  }
});

interface StartServiceOptions {
  readonly now?: () => number;
  readonly resetEnvironment?: () => Promise<void>;
  readonly resetIntervalMs?: number;
  readonly verifier?: TurnstileVerifier;
}

interface AdmissionResponse {
  readonly expiresAt: string;
  readonly protocol: string;
  readonly resetAt: string;
  readonly sessionLifetimeMs: number;
  readonly token: string;
  readonly webSocketPath: string;
}

interface WireMessage {
  readonly [key: string]: unknown;
  readonly requestId?: string;
  readonly type?: string;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function remoteDemoConfig(workspacePath: string): RemoteDemoConfig {
  return {
    allowedOrigin,
    buildRevision,
    guestGid: currentGid(),
    guestUid: currentUid(),
    host: '127.0.0.1',
    launcherPath: '/bin/sh',
    port: 0,
    turnstileExpectedAction: 'remote_shell_admission',
    turnstileExpectedHostname: 'pages.test',
    turnstileSecretKey: 'unused-injected-test-secret',
    workspacePath,
  };
}

function currentUid(): number {
  return process.getuid?.() ?? 0;
}

function currentGid(): number {
  return process.getgid?.() ?? 0;
}

function verifierReturning(result: boolean): TurnstileVerifier & {
  verify: ReturnType<typeof vi.fn>;
} {
  return { verify: vi.fn().mockResolvedValue(result) };
}

function verifierUnavailable(): TurnstileVerifier & {
  verify: ReturnType<typeof vi.fn>;
} {
  return {
    verify: vi.fn().mockRejectedValue(new TurnstileUnavailableError()),
  };
}

function requestAdmission(
  origin: string,
  options: {
    readonly body?: string;
    readonly contentType?: string;
    readonly forwardedFor?: string;
    readonly origin?: string;
  } = {},
): Promise<Response> {
  const headers = new Headers({ Origin: options.origin ?? allowedOrigin });
  if (options.forwardedFor !== undefined) {
    headers.set('x-forwarded-for', options.forwardedFor);
  }
  if ('contentType' in options) {
    if (options.contentType !== undefined) {
      headers.set('content-type', options.contentType);
    }
  } else {
    headers.set('content-type', 'application/x-www-form-urlencoded');
  }
  return fetch(`${origin}/v1/admissions`, {
    body:
      options.body ??
      new URLSearchParams({ turnstileToken: validCaptchaToken }).toString(),
    headers,
    method: 'POST',
  });
}

async function expectAdmissionError(
  responsePromise: Promise<Response>,
  status: number,
  error: string,
): Promise<void> {
  const response = await responsePromise;
  expect(response.status).toBe(status);
  expectSecurityHeaders(response);
  await expect(response.json()).resolves.toEqual({ error });
}

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-security-policy')).toBe(
    "default-src 'none'",
  );
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
}

async function requestGrant(origin: string): Promise<AdmissionResponse> {
  const response = await requestAdmission(origin);
  expect(response.status).toBe(201);
  return admissionGrant(response);
}

async function admissionGrant(response: Response): Promise<AdmissionResponse> {
  return (await response.json()) as AdmissionResponse;
}

function terminalUrl(origin: string): string {
  return `${origin.replace('http:', 'ws:')}/terminal`;
}

function admissionProtocols(token: string): string[] {
  return ['lit-shell.v1', `lit-shell.admission.${token}`];
}

async function connectTerminal(url: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(url, admissionProtocols(token), {
    origin: allowedOrigin,
  });
  const serverInfo = waitForMessage(
    socket,
    (message) => message.type === 'serverInfo',
  );
  await once(socket, 'open');
  await serverInfo;
  return socket;
}

async function spawn(
  socket: WebSocket,
  requestId: string,
  options?: Record<string, unknown>,
): Promise<string> {
  const response = waitForMessage(
    socket,
    (message) => message.requestId === requestId,
  );
  socket.send(JSON.stringify({ type: 'spawn', requestId, options }));
  const spawned = await response;
  expect(spawned).toMatchObject({ requestId, type: 'spawned' });
  expect(spawned.sessionId).toEqual(expect.any(String));
  return spawned.sessionId as string;
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, 'close');
  socket.close();
  await closed;
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

function connectRawTerminal(origin: string, token: string): Promise<Socket> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: url.hostname, port: Number(url.port) });
    let response = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error('Timed out waiting for raw WebSocket upgrade'));
    }, 2_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      if (!upgraded) {
        const headerEnd = response.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const headers = response.subarray(0, headerEnd).toString('latin1');
        if (!headers.startsWith('HTTP/1.1 101 ')) {
          cleanup();
          socket.destroy();
          reject(new Error(`Raw WebSocket upgrade failed: ${headers}`));
          return;
        }
        response = response.subarray(headerEnd + 4);
        upgraded = true;
      }
      // A post-upgrade frame proves TerminalServer finished initialization.
      if (response.length === 0) return;
      cleanup();
      socket.on('error', () => undefined);
      resolve(socket);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.write(
        [
          'GET /terminal HTTP/1.1',
          `Host: ${url.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
          'Sec-WebSocket-Version: 13',
          `Sec-WebSocket-Protocol: lit-shell.v1, lit-shell.admission.${token}`,
          `Origin: ${allowedOrigin}`,
          '',
          '',
        ].join('\r\n'),
      );
    });
  });
}

function maskedTextFrame(value: string): Buffer {
  const payload = Buffer.from(value, 'utf8');
  if (payload.length > 125)
    throw new Error('Test frame must stay unfragmented');
  const mask = randomBytes(4);
  const frame = Buffer.alloc(6 + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.length; index += 1) {
    frame[index + 6] = payload[index]! ^ mask[index % mask.length]!;
  }
  return frame;
}

function sendOversizedChunkedAdmission(origin: string): Promise<string> {
  const body = `turnstileToken=${'x'.repeat(
    REMOTE_DEMO_LIMITS.maxAdmissionBodyBytes,
  )}`;
  return sendRawHttpRequest(
    origin,
    [
      'POST /v1/admissions HTTP/1.1',
      `Host: ${new URL(origin).host}`,
      `Origin: ${allowedOrigin}`,
      'Content-Type: application/x-www-form-urlencoded',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      body.length.toString(16),
      body,
      '0',
      '',
      '',
    ].join('\r\n'),
  );
}

function sendRawHttpRequest(origin: string, request: string): Promise<string> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: url.hostname, port: Number(url.port) });
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for raw HTTP response'));
    }, 2_000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(response);
    });
    socket.once('connect', () => socket.end(request));
  });
}

async function expectUpgradeRejected(
  url: string,
  protocols: string[],
  expectedStatus: number,
  options: { readonly origin?: string } = {},
): Promise<void> {
  const socket = new WebSocket(url, protocols, {
    origin: options.origin ?? allowedOrigin,
  });
  socket.on('error', () => undefined);
  const [request, response] = (await once(socket, 'unexpected-response')) as [
    ClientRequest,
    IncomingMessage,
  ];
  expect(response.statusCode).toBe(expectedStatus);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  response.resume();
  request.destroy();
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
  timeout = 3_000,
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

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
