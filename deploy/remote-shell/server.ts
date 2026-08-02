import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { WebSocket, WebSocketServer } from 'ws';

import { TerminalServer } from '../../src/server/index.js';
import { AdmissionController, AdmissionUnavailableError } from './admission.js';
import {
  loadRemoteDemoConfig,
  REMOTE_DEMO_LIMITS,
  type RemoteDemoConfig,
} from './config.js';
import { resetSharedEnvironment } from './shared-environment.js';
import {
  createTurnstileVerifier,
  TurnstileUnavailableError,
  type TurnstileVerifier,
  VerificationAttemptLimiter,
} from './turnstile.js';

const execFileAsync = promisify(execFile);
const APPLICATION_PROTOCOL = 'lit-shell.v1';
const ADMISSION_PROTOCOL_PREFIX = 'lit-shell.admission.';
const GUEST_SELF_TEST_MARKER = 'lit-shell-guest-self-test-ok';
const RESET_CLOSE_CODE = 1012;
const RESET_CLOSE_REASON = 'Shared demo reset';

export interface RemoteDemoService {
  readonly httpServer: HttpServer;
  readonly terminalServer: TerminalServer;
  close(): Promise<void>;
  listen(): Promise<{ origin: string }>;
  resetNow(): Promise<void>;
}

interface RemoteDemoServiceOptions {
  readonly config: RemoteDemoConfig;
  readonly now?: () => number;
  readonly onResetFailure?: (error: unknown) => void;
  readonly prepareEnvironment?: () => Promise<void>;
  readonly resetEnvironment?: () => Promise<void>;
  readonly resetIntervalMs?: number;
  readonly turnstileVerifier?: TurnstileVerifier;
}

export async function createRemoteDemoService(
  options: RemoteDemoServiceOptions,
): Promise<RemoteDemoService> {
  const { config } = options;
  const now = options.now ?? Date.now;
  const resetIntervalMs = positiveInteger(
    options.resetIntervalMs ?? REMOTE_DEMO_LIMITS.resetIntervalMs,
    'resetIntervalMs',
  );
  const resetEnvironment =
    options.resetEnvironment ?? (() => resetSharedEnvironment(config));
  const prepareEnvironment =
    options.prepareEnvironment ??
    (() => preflightSharedDemo(config, resetEnvironment));
  const verifier =
    options.turnstileVerifier ??
    createTurnstileVerifier({
      expectedAction: config.turnstileExpectedAction,
      expectedHostname: config.turnstileExpectedHostname,
      secretKey: config.turnstileSecretKey,
    });
  await prepareEnvironment();

  const admissions = new AdmissionController({
    activeLeaseMs: REMOTE_DEMO_LIMITS.activeLeaseMs,
    capacity: REMOTE_DEMO_LIMITS.admissionCapacity,
    pendingLeaseMs: REMOTE_DEMO_LIMITS.pendingLeaseMs,
  });
  const attempts = new VerificationAttemptLimiter({
    burst: REMOTE_DEMO_LIMITS.maxVerificationBurst,
    maxConcurrent: REMOTE_DEMO_LIMITS.maxConcurrentVerifications,
    now,
    refillIntervalMs: REMOTE_DEMO_LIMITS.verificationRefillIntervalMs,
  });
  const approvedRequests = new WeakSet<IncomingMessage>();
  let terminalServer = createSharedTerminalServer(config, approvedRequests);
  let accepting = true;
  let closed = false;
  let epoch = 1;
  let resetAt = now() + resetIntervalMs;
  let resetPromise: Promise<void> | undefined;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  const webSocketServer = new WebSocketServer({
    handleProtocols(protocols) {
      return protocols.has(APPLICATION_PROTOCOL) ? APPLICATION_PROTOCOL : false;
    },
    maxPayload: REMOTE_DEMO_LIMITS.maxMessageBytes,
    noServer: true,
    perMessageDeflate: false,
  });
  const state = () => ({ accepting, epoch, resetAt });
  const httpServer = createServer(
    {
      headersTimeout: 5_000,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 8 * 1024,
      requestTimeout: 5_000,
    },
    (request, response) => {
      void handleHttpRequest(
        request,
        response,
        config,
        admissions,
        attempts,
        verifier,
        state,
        now,
      ).catch((error: unknown) => {
        if (error instanceof HttpRequestError) {
          if (error.statusCode === 413) {
            response.setHeader('connection', 'close');
          }
          if (error.retryAfterSeconds !== undefined) {
            response.setHeader('retry-after', String(error.retryAfterSeconds));
          }
          writeJson(response, error.statusCode, { error: error.message });
          return;
        }
        writeJson(response, 500, { error: 'Internal server error' });
      });
    },
  );
  httpServer.maxHeadersCount = 32;
  httpServer.maxRequestsPerSocket = 10;

  const scheduleReset = () => {
    if (closed || resetTimer) return;
    resetTimer = setTimeout(
      () => {
        resetTimer = undefined;
        void resetNow().catch((error: unknown) => {
          console.error(
            '[remote-demo] shared environment reset failed:',
            error instanceof Error ? error.message : 'unknown error',
          );
          options.onResetFailure?.(error);
        });
      },
      Math.max(1, resetAt - now()),
    );
    resetTimer.unref();
  };

  const resetNow = (): Promise<void> => {
    if (resetPromise) return resetPromise;
    resetPromise = (async () => {
      accepting = false;
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = undefined;
      for (const client of webSocketServer.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.close(RESET_CLOSE_CODE, RESET_CLOSE_REASON);
        } else {
          client.terminate();
        }
      }
      terminalServer.close();
      admissions.reset();
      await resetEnvironment();
      if (closed) return;
      for (const client of webSocketServer.clients) client.terminate();
      terminalServer = createSharedTerminalServer(config, approvedRequests);
      epoch += 1;
      resetAt = now() + resetIntervalMs;
      accepting = true;
      scheduleReset();
    })().finally(() => {
      resetPromise = undefined;
    });
    return resetPromise;
  };

  httpServer.on('upgrade', (request, socket, head) => {
    handleUpgrade(
      request,
      socket,
      head,
      config,
      admissions,
      approvedRequests,
      () => terminalServer,
      webSocketServer,
      () => accepting,
    );
  });
  httpServer.on('clientError', (_error, socket) => {
    rejectUpgrade(socket, 400, 'Bad Request');
  });

  return {
    httpServer,
    get terminalServer() {
      return terminalServer;
    },
    async close() {
      if (closed) return;
      closed = true;
      accepting = false;
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = undefined;
      terminalServer.close();
      for (const client of webSocketServer.clients) client.terminate();
      webSocketServer.close();
      httpServer.closeAllConnections();
      if (httpServer.listening) {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    },
    async listen() {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(config.port, config.host);
      });
      scheduleReset();
      const address = httpServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('Remote demo did not expose a TCP address');
      }
      const host = ['0.0.0.0', '::'].includes(config.host)
        ? '127.0.0.1'
        : config.host;
      return { origin: `http://${host}:${String(address.port)}` };
    },
    resetNow,
  };
}

function createSharedTerminalServer(
  config: RemoteDemoConfig,
  approvedRequests: WeakSet<IncomingMessage>,
): TerminalServer {
  return new TerminalServer({
    allowDockerExec: false,
    allowedClientOptions: ['allowJoin', 'cols', 'rows'],
    allowedOrigins: [config.allowedOrigin],
    allowedPaths: [config.workspacePath],
    allowedShells: [config.launcherPath],
    allowSessionSharing: false,
    authorize: (request) => approvedRequests.delete(request),
    cleanupInterval: 1_000,
    defaultCwd: config.workspacePath,
    defaultShell: config.launcherPath,
    historyEnabled: false,
    historySize: 0,
    idleTimeout: REMOTE_DEMO_LIMITS.idleTimeoutMs,
    localEnvironment: {
      HOME: config.workspacePath,
      LANG: 'C.UTF-8',
      LOGNAME: 'guest',
      PATH: '/bin:/usr/bin',
      PS1: 'guest@shared-lit-shell:\\w$ ',
      SHELL: '/bin/sh',
      TERM: 'xterm-256color',
      TMPDIR: `${config.workspacePath}/tmp`,
      USER: 'guest',
    },
    localGid: config.guestGid,
    localUid: config.guestUid,
    maxBufferedOutputBytes: REMOTE_DEMO_LIMITS.maxBufferedOutputBytes,
    maxClientsPerSession: 1,
    maxConnectionBytes: REMOTE_DEMO_LIMITS.maxConnectionBytes,
    maxConnectionMessages: REMOTE_DEMO_LIMITS.maxConnectionMessages,
    maxMessageBytes: REMOTE_DEMO_LIMITS.maxMessageBytes,
    maxPreAuthBytes: REMOTE_DEMO_LIMITS.maxMessageBytes,
    maxPreAuthMessages: 2,
    maxSessionInputBytes: REMOTE_DEMO_LIMITS.maxInputBytes,
    maxSessionLifetime: REMOTE_DEMO_LIMITS.sessionLifetimeMs,
    maxSessionOutputBytes: REMOTE_DEMO_LIMITS.maxOutputBytes,
    maxSessionsCreatedPerConnection: 1,
    maxSessionsPerClient: 1,
    maxSessionsTotal: REMOTE_DEMO_LIMITS.admissionCapacity,
    orphanTimeout: 0,
    path: '/terminal',
    verbose: false,
  });
}

interface RemoteDemoState {
  readonly accepting: boolean;
  readonly epoch: number;
  readonly resetAt: number;
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: RemoteDemoConfig,
  admissions: AdmissionController,
  attempts: VerificationAttemptLimiter,
  verifier: TurnstileVerifier,
  state: () => RemoteDemoState,
  now: () => number,
): Promise<void> {
  applyResponseHeaders(response);
  applyCorsResponseHeaders(request, response, config.allowedOrigin);
  const pathname = requestPathname(request);
  const current = state();
  if (request.method === 'GET' && pathname === '/health/live') {
    writeJson(response, 200, {
      epoch: current.epoch,
      resetAt: new Date(current.resetAt).toISOString(),
      revision: config.buildRevision,
      status: 'live',
    });
    return;
  }
  if (request.method === 'GET' && pathname === '/health/ready') {
    if (!current.accepting) {
      writeJson(response, 503, {
        epoch: current.epoch,
        resetAt: new Date(current.resetAt).toISOString(),
        revision: config.buildRevision,
        status: 'resetting',
      });
      return;
    }
    writeJson(response, 200, {
      admission: admissions.snapshot(),
      epoch: current.epoch,
      resetAt: new Date(current.resetAt).toISOString(),
      revision: config.buildRevision,
      status: 'ready',
    });
    return;
  }
  if (request.method !== 'POST' || pathname !== '/v1/admissions') {
    writeJson(response, 404, { error: 'Not found' });
    return;
  }
  if (!current.accepting) {
    throw new HttpRequestError(503, 'Shared environment is resetting', 2);
  }
  if (request.headers.origin !== config.allowedOrigin) {
    throw new HttpRequestError(403, 'Origin is not allowed');
  }

  const token = await readTurnstileToken(request);
  const releaseAttempt = attempts.begin();
  if (!releaseAttempt) {
    throw new HttpRequestError(
      429,
      'Too many verification attempts',
      attempts.retryAfterSeconds(),
    );
  }

  let verified: boolean;
  try {
    verified = await verifier.verify(token);
  } catch (error) {
    if (error instanceof TurnstileUnavailableError) {
      throw new HttpRequestError(
        503,
        'Human verification is temporarily unavailable',
        5,
      );
    }
    throw error;
  } finally {
    releaseAttempt();
  }
  if (!verified) {
    throw new HttpRequestError(403, 'Human verification failed');
  }
  const afterVerification = state();
  if (
    !afterVerification.accepting ||
    afterVerification.epoch !== current.epoch
  ) {
    throw new HttpRequestError(
      503,
      'Shared environment reset during verification',
      2,
    );
  }

  try {
    const grant = admissions.issue();
    writeJson(response, 201, {
      expiresAt: new Date(grant.expiresAt).toISOString(),
      protocol: APPLICATION_PROTOCOL,
      resetAt: new Date(afterVerification.resetAt).toISOString(),
      sessionLifetimeMs: Math.max(
        1,
        Math.min(
          REMOTE_DEMO_LIMITS.sessionLifetimeMs,
          afterVerification.resetAt - now(),
        ),
      ),
      token: grant.token,
      webSocketPath: '/terminal',
    });
  } catch (error) {
    if (!(error instanceof AdmissionUnavailableError)) throw error;
    throw new HttpRequestError(429, error.message, error.retryAfterSeconds);
  }
}

function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  config: RemoteDemoConfig,
  admissions: AdmissionController,
  approvedRequests: WeakSet<IncomingMessage>,
  terminalServer: () => TerminalServer,
  webSocketServer: WebSocketServer,
  accepting: () => boolean,
): void {
  if (
    !accepting() ||
    request.method !== 'GET' ||
    requestPathname(request) !== '/terminal' ||
    request.headers.origin !== config.allowedOrigin
  ) {
    rejectUpgrade(socket, 403, 'Forbidden');
    return;
  }
  const token = admissionProtocolToken(
    request.headers['sec-websocket-protocol'],
  );
  const lease = token ? admissions.consume(token) : undefined;
  if (!lease) {
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }

  let upgraded = false;
  const releaseAbortedUpgrade = () => {
    if (upgraded) return;
    approvedRequests.delete(request);
    admissions.release(lease.id);
  };
  socket.once('close', releaseAbortedUpgrade);
  approvedRequests.add(request);
  try {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      upgraded = true;
      socket.off('close', releaseAbortedUpgrade);
      let terminationTimer: ReturnType<typeof setTimeout> | undefined;
      const deadlineTimer = setTimeout(
        () => {
          webSocket.close(1000, 'Remote demo lease expired');
          terminationTimer = setTimeout(() => webSocket.terminate(), 1_000);
          terminationTimer.unref();
        },
        Math.max(1, lease.deadline - Date.now()),
      );
      deadlineTimer.unref();
      webSocket.once('close', () => {
        clearTimeout(deadlineTimer);
        if (terminationTimer) clearTimeout(terminationTimer);
        admissions.release(lease.id);
      });
      void terminalServer()
        .handleConnection(webSocket, request)
        .catch(() => webSocket.terminate());
    });
  } catch {
    socket.off('close', releaseAbortedUpgrade);
    approvedRequests.delete(request);
    admissions.release(lease.id);
    rejectUpgrade(socket, 500, 'Internal Server Error');
  }
}

function admissionProtocolToken(
  header: string | string[] | undefined,
): string | undefined {
  if (typeof header !== 'string') return undefined;
  const protocols = header.split(',').map((protocol) => protocol.trim());
  if (protocols.length !== 2 || !protocols.includes(APPLICATION_PROTOCOL)) {
    return undefined;
  }
  const capability = protocols.find((protocol) =>
    protocol.startsWith(ADMISSION_PROTOCOL_PREFIX),
  );
  const token = capability?.slice(ADMISSION_PROTOCOL_PREFIX.length);
  return token && /^[A-Za-z0-9_-]{43,}$/u.test(token) ? token : undefined;
}

async function readTurnstileToken(request: IncomingMessage): Promise<string> {
  const contentType = request.headers['content-type']
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') {
    throw new HttpRequestError(
      415,
      'Admission requires a form-encoded verification token',
    );
  }
  const declaredLength = Number(request.headers['content-length']);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > REMOTE_DEMO_LIMITS.maxAdmissionBodyBytes
  ) {
    request.resume();
    throw new HttpRequestError(413, 'Admission request is too large');
  }

  const body = await readBoundedRequestBody(
    request,
    REMOTE_DEMO_LIMITS.maxAdmissionBodyBytes,
  );
  const form = new URLSearchParams(body.toString('utf8'));
  const keys = Array.from(form.keys());
  const values = form.getAll('turnstileToken');
  if (
    keys.length !== 1 ||
    keys[0] !== 'turnstileToken' ||
    values.length !== 1
  ) {
    throw new HttpRequestError(
      400,
      'Admission requires exactly one verification token',
    );
  }
  const token = values[0] ?? '';
  if (
    token.length < 1 ||
    token.length > 2_048 ||
    hasAsciiControlOrSpace(token)
  ) {
    throw new HttpRequestError(400, 'Verification token is malformed');
  }
  return token;
}

function readBoundedRequestBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    request.on('data', (chunk: unknown) => {
      if (settled) return;
      if (!(chunk instanceof Uint8Array)) {
        settled = true;
        request.resume();
        reject(new HttpRequestError(400, 'Admission request body is invalid'));
        return;
      }
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maximumBytes) {
        settled = true;
        request.resume();
        reject(new HttpRequestError(413, 'Admission request is too large'));
        return;
      }
      chunks.push(buffer);
    });
    request.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    const rejectIncomplete = () => {
      if (settled) return;
      settled = true;
      reject(new HttpRequestError(400, 'Admission request body is incomplete'));
    };
    request.once('aborted', rejectIncomplete);
    request.once('error', rejectIncomplete);
  });
}

function hasAsciiControlOrSpace(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20 || codePoint === 0x7f;
  });
}

function requestPathname(request: IncomingMessage): string | undefined {
  try {
    const url = new URL(request.url ?? '/', 'http://remote-demo.invalid');
    return url.search || url.hash ? undefined : url.pathname;
  } catch {
    return undefined;
  }
}

function applyResponseHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', "default-src 'none'");
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
}

function applyCorsResponseHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigin: string,
): void {
  if (request.headers.origin !== allowedOrigin) return;
  response.setHeader('access-control-allow-origin', allowedOrigin);
  response.setHeader('access-control-expose-headers', 'Retry-After');
  response.setHeader('vary', 'Origin');
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  value: Record<string, unknown>,
): void {
  if (response.headersSent || response.destroyed) return;
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function rejectUpgrade(
  socket: Duplex,
  statusCode: number,
  reason: string,
): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${String(statusCode)} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n' +
      'Cache-Control: no-store\r\n' +
      'X-Content-Type-Options: nosniff\r\n' +
      '\r\n',
  );
}

async function preflightSharedDemo(
  config: RemoteDemoConfig,
  resetEnvironment: () => Promise<void>,
): Promise<void> {
  await access(config.launcherPath, fsConstants.X_OK);
  await import('node-pty');
  let stdout: string;
  try {
    const result = await execFileAsync(config.launcherPath, ['--self-test'], {
      encoding: 'utf8',
      env: {},
      gid: config.guestGid,
      maxBuffer: 16 * 1024,
      timeout: 5_000,
      uid: config.guestUid,
    });
    stdout = result.stdout;
  } catch (error) {
    throw new Error('The fixed guest identity transition is unavailable', {
      cause: error,
    });
  }
  if (stdout.trim() !== GUEST_SELF_TEST_MARKER) {
    throw new Error('The fixed guest identity self-test did not pass');
  }
  await resetEnvironment();
}

function assertRootGatewayIdentity(): void {
  if (
    process.platform !== 'linux' ||
    !process.getuid ||
    !process.setgroups ||
    !process.getgroups ||
    process.getuid() !== 0
  ) {
    throw new Error('The disposable demo gateway must start as Linux root');
  }
  process.setgroups([]);
  // Node includes the effective GID in getgroups() even when the kernel's
  // supplementary group list is empty. The launcher self-test below proves
  // that no root group crosses the subsequent UID/GID transition.
  if (process.getgroups().some((group) => group !== 0)) {
    throw new Error('The disposable demo gateway retained an unexpected group');
  }
}

async function main(): Promise<void> {
  assertRootGatewayIdentity();
  const service = await createRemoteDemoService({
    config: loadRemoteDemoConfig(),
    onResetFailure: () => process.exit(1),
  });
  const shutdown = () => {
    void service.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.on('SIGUSR2', () => {
    void service.resetNow().catch((error: unknown) => {
      console.error(
        '[remote-demo] requested shared environment reset failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
      process.exit(1);
    });
  });
  await service.listen();
  console.log('[remote-demo] ready');
}

class HttpRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(
      '[remote-demo] startup failed:',
      error instanceof Error ? error.message : 'unknown error',
    );
    process.exitCode = 1;
  });
}
