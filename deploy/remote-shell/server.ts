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

import { WebSocketServer } from 'ws';

import { TerminalServer } from '../../src/server/index.js';
import { AdmissionController, AdmissionUnavailableError } from './admission.js';
import {
  loadRemoteDemoConfig,
  REMOTE_DEMO_LIMITS,
  type RemoteDemoConfig,
} from './config.js';

const execFileAsync = promisify(execFile);
const APPLICATION_PROTOCOL = 'lit-shell.v1';
const ADMISSION_PROTOCOL_PREFIX = 'lit-shell.admission.';
const SANDBOX_SELF_TEST_MARKER = 'lit-shell-sandbox-self-test-ok';
const SANDBOX_RECOVERY_TIMEOUT_MS = 5_000;

export interface RemoteDemoService {
  readonly httpServer: HttpServer;
  readonly terminalServer: TerminalServer;
  close(): Promise<void>;
  listen(): Promise<{ origin: string }>;
}

interface RemoteDemoServiceOptions {
  readonly config: RemoteDemoConfig;
  readonly preflight?: () => Promise<void>;
  readonly sandboxRecoveryTimeoutMs?: number;
}

export async function createRemoteDemoService(
  options: RemoteDemoServiceOptions,
): Promise<RemoteDemoService> {
  const { config } = options;
  const verifySandbox =
    options.preflight ?? (() => preflightSandbox(config.launcherPath));
  const sandboxRecoveryTimeoutMs =
    options.sandboxRecoveryTimeoutMs ?? SANDBOX_RECOVERY_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(sandboxRecoveryTimeoutMs) ||
    sandboxRecoveryTimeoutMs <= 0
  ) {
    throw new TypeError('sandboxRecoveryTimeoutMs must be a positive integer');
  }
  await verifySandbox();
  let sandboxHealthy = true;

  const admissions = new AdmissionController({
    activeLeaseMs: REMOTE_DEMO_LIMITS.activeLeaseMs,
    pendingLeaseMs: REMOTE_DEMO_LIMITS.pendingLeaseMs,
  });
  const approvedRequests = new WeakSet<IncomingMessage>();
  const terminalServer = createLockedTerminalServer(config, approvedRequests);
  const webSocketServer = new WebSocketServer({
    handleProtocols(protocols) {
      return protocols.has(APPLICATION_PROTOCOL) ? APPLICATION_PROTOCOL : false;
    },
    maxPayload: REMOTE_DEMO_LIMITS.maxMessageBytes,
    noServer: true,
    perMessageDeflate: false,
  });
  const httpServer = createServer(
    {
      headersTimeout: 5_000,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 8 * 1024,
      requestTimeout: 5_000,
    },
    (request, response) => {
      try {
        handleHttpRequest(
          request,
          response,
          config,
          admissions,
          () => sandboxHealthy,
        );
      } catch {
        writeJson(response, 500, { error: 'Internal server error' });
      }
    },
  );
  httpServer.maxHeadersCount = 32;
  httpServer.maxRequestsPerSocket = 10;

  const releaseAfterSandboxRecovery = (leaseId: number) => {
    sandboxHealthy = false;
    void waitForSandboxRecovery(verifySandbox, sandboxRecoveryTimeoutMs)
      .then(() => {
        admissions.release(leaseId);
        sandboxHealthy = true;
      })
      .catch((error: unknown) => {
        console.error(
          '[remote-demo] sandbox cleanup verification failed:',
          error instanceof Error ? error.message : 'unknown error',
        );
      });
  };

  httpServer.on('upgrade', (request, socket, head) => {
    handleUpgrade(
      request,
      socket,
      head,
      config,
      admissions,
      approvedRequests,
      terminalServer,
      webSocketServer,
      releaseAfterSandboxRecovery,
    );
  });
  httpServer.on('clientError', (_error, socket) => {
    rejectUpgrade(socket, 400, 'Bad Request');
  });

  return {
    httpServer,
    terminalServer,
    async close() {
      terminalServer.close();
      for (const client of webSocketServer.clients) client.terminate();
      webSocketServer.close();
      httpServer.closeAllConnections();
      if (!httpServer.listening) return;
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
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
      const address = httpServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('Remote demo did not expose a TCP address');
      }
      const host = ['0.0.0.0', '::'].includes(config.host)
        ? '127.0.0.1'
        : config.host;
      return { origin: `http://${host}:${String(address.port)}` };
    },
  };
}

function createLockedTerminalServer(
  config: RemoteDemoConfig,
  approvedRequests: WeakSet<IncomingMessage>,
): TerminalServer {
  return new TerminalServer({
    allowDockerExec: false,
    allowedClientOptions: ['allowJoin', 'cols', 'rows'],
    allowedOrigins: [config.allowedOrigin],
    allowedPaths: ['/'],
    allowedShells: [config.launcherPath],
    allowSessionSharing: false,
    authorize: (request) => approvedRequests.delete(request),
    cleanupInterval: 1_000,
    defaultCwd: '/',
    defaultShell: config.launcherPath,
    historyEnabled: false,
    historySize: 0,
    idleTimeout: REMOTE_DEMO_LIMITS.idleTimeoutMs,
    localEnvironment: {
      HOME: '/home/demo',
      LANG: 'C.UTF-8',
      LOGNAME: 'demo',
      PATH: '/bin:/usr/bin',
      PS1: 'guest@lit-shell:\\w$ ',
      SHELL: '/bin/sh',
      TERM: 'xterm-256color',
      USER: 'demo',
    },
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
    maxSessionsTotal: 1,
    orphanTimeout: 0,
    path: '/terminal',
    verbose: false,
  });
}

function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: RemoteDemoConfig,
  admissions: AdmissionController,
  sandboxReady: () => boolean,
): void {
  applyResponseHeaders(response);
  applyCorsResponseHeaders(request, response, config.allowedOrigin);
  const pathname = requestPathname(request);
  if (request.method === 'GET' && pathname === '/health/live') {
    writeJson(response, 200, {
      revision: config.buildRevision,
      status: 'live',
    });
    return;
  }
  if (request.method === 'GET' && pathname === '/health/ready') {
    if (!sandboxReady()) {
      writeJson(response, 503, {
        revision: config.buildRevision,
        status: 'unavailable',
      });
      return;
    }
    writeJson(response, 200, {
      admission: admissions.status(),
      revision: config.buildRevision,
      status: 'ready',
    });
    return;
  }
  if (request.method !== 'POST' || pathname !== '/v1/admissions') {
    writeJson(response, 404, { error: 'Not found' });
    return;
  }
  if (!sandboxReady()) {
    writeJson(response, 503, { error: 'Sandbox is unavailable' });
    return;
  }
  if (request.headers.origin !== config.allowedOrigin) {
    writeJson(response, 403, { error: 'Origin is not allowed' });
    return;
  }
  if (requestHasBody(request)) {
    writeJson(response, 413, { error: 'Admission requests must have no body' });
    return;
  }

  try {
    const grant = admissions.issue();
    writeJson(response, 201, {
      expiresAt: new Date(grant.expiresAt).toISOString(),
      protocol: APPLICATION_PROTOCOL,
      sessionLifetimeMs: REMOTE_DEMO_LIMITS.sessionLifetimeMs,
      token: grant.token,
      webSocketPath: '/terminal',
    });
  } catch (error) {
    if (!(error instanceof AdmissionUnavailableError)) throw error;
    response.setHeader('retry-after', String(error.retryAfterSeconds));
    writeJson(response, 429, { error: error.message });
  }
}

function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  config: RemoteDemoConfig,
  admissions: AdmissionController,
  approvedRequests: WeakSet<IncomingMessage>,
  terminalServer: TerminalServer,
  webSocketServer: WebSocketServer,
  releaseAfterSandboxRecovery: (leaseId: number) => void,
): void {
  if (
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
        releaseAfterSandboxRecovery(lease.id);
      });
      void terminalServer.handleConnection(webSocket, request).catch(() => {
        webSocket.terminate();
      });
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

function requestHasBody(request: IncomingMessage): boolean {
  const contentLength = request.headers['content-length'];
  return (
    request.headers['transfer-encoding'] !== undefined ||
    (contentLength !== undefined && contentLength !== '0')
  );
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

async function preflightSandbox(launcherPath: string): Promise<void> {
  await access(launcherPath, fsConstants.X_OK);
  await import('node-pty');
  const result = await execFileAsync(launcherPath, ['--self-test'], {
    encoding: 'utf8',
    env: {},
    maxBuffer: 16 * 1024,
    timeout: 5_000,
  });
  if (result.stdout.trim() !== SANDBOX_SELF_TEST_MARKER) {
    throw new Error('The sandbox launcher self-test did not pass');
  }
}

async function waitForSandboxRecovery(
  verifySandbox: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      await verifySandbox();
      return;
    } catch (error) {
      lastError = error;
    }
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(100, remainingMs)),
    );
  } while (performance.now() < deadline);
  throw new Error('The sandbox did not recover after session cleanup', {
    cause: lastError,
  });
}

async function main(): Promise<void> {
  const service = await createRemoteDemoService({
    config: loadRemoteDemoConfig(),
  });
  const shutdown = () => {
    void service.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await service.listen();
  console.log('[remote-demo] ready');
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
