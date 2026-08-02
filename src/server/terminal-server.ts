/**
 * Server-side terminal handler using node-pty
 *
 * Manages PTY sessions and WebSocket connections for web-based terminals.
 * Supports session multiplexing - multiple clients can connect to the same session.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { WebSocket, WebSocketServer, type RawData } from 'ws';

import type {
  ServerConfig,
  TerminalOptions,
  SessionInfo,
  ContainerInfo,
  ServerInfo,
  SharedSessionInfo,
  SessionListFilter,
} from '../shared/types.js';
import {
  SessionManager,
  type SharedSession,
  type TerminalProcess,
} from './session-manager.js';
import {
  DEFAULT_MAX_BUFFERED_OUTPUT_BYTES,
  isSafeIntegerInRange,
  MAX_TERMINAL_COLUMNS,
  MAX_TERMINAL_ROWS,
  MAX_TIMER_DELAY_MS,
  resolveSafeIntegerOption,
} from './numeric-limits.js';
import { secureTokenMatches } from './secure-token.js';
import {
  canQueueWebSocketMessage,
  closeForOutputBackpressure,
} from './websocket-output.js';

type JsonObject = Record<string, unknown>;
type RequestId = string;

const DEFAULT_MAX_PRE_AUTH_MESSAGES = 32;
const DEFAULT_MAX_PRE_AUTH_BYTES = 64 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DOCKER_LIST_TIMEOUT_MS = 5_000;
const DOCKER_LIST_MAX_BUFFER_BYTES = 1024 * 1024;
const DOCKER_LIST_CACHE_TTL_MS = 1_000;
const PRE_AUTH_LIMIT_ERROR = 'Pre-authorization request limit exceeded';

const DOCKER_CONTAINER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DOCKER_CONTAINER_USER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const DOCKER_CONTAINER_NUMERIC_ID_PATTERN = /^[0-9]+$/;
const PORTABLE_ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const TERMINAL_OPTION_KEYS = new Set([
  'shell',
  'cwd',
  'env',
  'cols',
  'rows',
  'container',
  'containerShell',
  'containerUser',
  'containerCwd',
  'attachMode',
  'label',
  'allowJoin',
  'enableHistory',
  'orphanTimeout',
  'useTmux',
  'tmuxSession',
]);
const SESSION_FILTER_KEYS = new Set(['type', 'container', 'accepting']);
const JOIN_OPTION_KEYS = new Set([
  'sessionId',
  'requestHistory',
  'historyLimit',
  'resumeToken',
]);
const TERMINAL_SERVER_OPTION_KEYS = new Set([
  'allowedShells',
  'allowedPaths',
  'defaultShell',
  'defaultCwd',
  'maxSessionsPerClient',
  'idleTimeout',
  'allowLocalExec',
  'allowDockerExec',
  'allowedContainerPatterns',
  'defaultContainerShell',
  'path',
  'verbose',
  'dockerPath',
  'allowedOrigins',
  'authorize',
  'maxPreAuthMessages',
  'maxPreAuthBytes',
  'maxMessageBytes',
  'maxBufferedOutputBytes',
  'cleanupInterval',
  'maxClientsPerSession',
  'orphanTimeout',
  'historySize',
  'historyEnabled',
  'maxSessionsTotal',
]);

const LOCAL_INCOMPATIBLE_OPTIONS = [
  'containerShell',
  'containerUser',
  'containerCwd',
  'attachMode',
  'useTmux',
  'tmuxSession',
] as const;
const DOCKER_ATTACH_INCOMPATIBLE_OPTIONS = [
  'shell',
  'cwd',
  'containerShell',
  'containerUser',
  'containerCwd',
  'env',
  'useTmux',
  'tmuxSession',
] as const;
const DOCKER_EXEC_INCOMPATIBLE_OPTIONS = ['shell', 'cwd'] as const;
const CONTAINER_STATES = new Set<ContainerInfo['state']>([
  'running',
  'paused',
  'exited',
]);

class ConnectionPolicyError extends Error {}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd?: string;
      env: Record<string, string | undefined>;
    },
  ): TerminalProcess;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertKnownKeys(
  value: JsonObject,
  allowedKeys: ReadonlySet<string>,
  context: string,
): void {
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey !== undefined) {
    throw new TypeError(`${context} contains unknown key: ${unknownKey}`);
  }
}

function firstDefinedKey(
  value: JsonObject,
  keys: readonly string[],
): string | undefined {
  // Keys come exclusively from fixed server-owned option lists above.
  // eslint-disable-next-line security/detect-object-injection
  return keys.find((key) => value[key] !== undefined);
}

function rejectIncompatibleOptions(
  value: JsonObject,
  keys: readonly string[],
  mode: string,
): void {
  const incompatible = firstDefinedKey(value, keys);
  if (incompatible !== undefined) {
    throw new Error(`${incompatible} is not supported for ${mode} sessions`);
  }
}

function assertOptionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean`);
  }
}

function assertOptionalNonEmptyString(value: unknown, name: string): void {
  if (value !== undefined && !isNonEmptyString(value)) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertOptionalStringArray(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array of non-empty strings`);
  }
  const invalidIndex = value.findIndex((entry) => !isNonEmptyString(entry));
  if (invalidIndex !== -1) {
    throw new TypeError(`${name}[${invalidIndex}] must be a non-empty string`);
  }
}

function assertOptionalAuthorize(value: unknown): void {
  if (value !== undefined && typeof value !== 'function') {
    throw new TypeError('authorize must be a function');
  }
}

function validateTerminalServerOptionTypes(
  options: TerminalServerOptions,
): void {
  assertOptionalStringArray(options.allowedShells, 'allowedShells');
  assertOptionalStringArray(options.allowedPaths, 'allowedPaths');
  assertOptionalStringArray(
    options.allowedContainerPatterns,
    'allowedContainerPatterns',
  );
  assertOptionalStringArray(options.allowedOrigins, 'allowedOrigins');
  assertOptionalNonEmptyString(options.defaultShell, 'defaultShell');
  assertOptionalNonEmptyString(options.defaultCwd, 'defaultCwd');
  assertOptionalNonEmptyString(
    options.defaultContainerShell,
    'defaultContainerShell',
  );
  assertOptionalNonEmptyString(options.path, 'path');
  assertOptionalNonEmptyString(options.dockerPath, 'dockerPath');
  assertOptionalBoolean(options.allowLocalExec, 'allowLocalExec');
  assertOptionalBoolean(options.allowDockerExec, 'allowDockerExec');
  assertOptionalBoolean(options.historyEnabled, 'historyEnabled');
  assertOptionalBoolean(options.verbose, 'verbose');
  assertOptionalAuthorize(options.authorize);
}

function assertTerminalOptionCompatibility(value: JsonObject): void {
  if (value.container === undefined) {
    rejectIncompatibleOptions(value, LOCAL_INCOMPATIBLE_OPTIONS, 'local');
    return;
  }
  if (value.attachMode === true) {
    rejectIncompatibleOptions(
      value,
      DOCKER_ATTACH_INCOMPATIBLE_OPTIONS,
      'Docker attach',
    );
    return;
  }
  rejectIncompatibleOptions(
    value,
    DOCKER_EXEC_INCOMPATIBLE_OPTIONS,
    'Docker exec',
  );
  if (value.tmuxSession !== undefined && value.useTmux !== true) {
    throw new Error('tmuxSession requires useTmux: true');
  }
}

function normalizeContainerState(
  value: string | undefined,
): ContainerInfo['state'] {
  return CONTAINER_STATES.has(value as ContainerInfo['state'])
    ? (value as ContainerInfo['state'])
    : 'unknown';
}

function parseContainerLine(line: string): ContainerInfo | undefined {
  const [id, name, image, status, state] = line.split('\t');
  if (!id || !name) return undefined;
  return {
    id,
    name,
    image: image ?? '',
    status: status ?? '',
    state: normalizeContainerState(state),
  };
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

function closeOpenWebSocket(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
}

function connectionPolicyCloseReason(error: ConnectionPolicyError): string {
  return error.message === PRE_AUTH_LIMIT_ERROR
    ? PRE_AUTH_LIMIT_ERROR
    : 'Connection rejected by server policy';
}

function acceptedMessageBytes(
  ws: WebSocket,
  data: RawData,
  maximum: number,
): number | undefined {
  const messageBytes = rawDataByteLength(data);
  if (messageBytes <= maximum) return messageBytes;
  closeOpenWebSocket(ws, 1009, 'Protocol request is too large');
  return undefined;
}

function isValidContainerUser(value: string): boolean {
  const components = value.split(':');
  return (
    components.length <= 2 &&
    components.every(
      (component) =>
        DOCKER_CONTAINER_USER_NAME_PATTERN.test(component) ||
        DOCKER_CONTAINER_NUMERIC_ID_PATTERN.test(component),
    )
  );
}

function compileContainerMatcher(pattern: string, index: number): RegExp {
  if (typeof pattern !== 'string') {
    throw new TypeError(
      `Invalid allowedContainerPatterns[${index}]: pattern must be a string`,
    );
  }

  try {
    // Patterns are trusted administrator configuration, never client input.
    // Wrapping them makes allow-list matching explicit and whole-string only.
    // eslint-disable-next-line security/detect-non-literal-regexp
    return new RegExp(`^(?:${pattern})$`);
  } catch (error) {
    throw new TypeError(
      `Invalid allowedContainerPatterns[${index}]: pattern must be a valid regular expression`,
      { cause: error },
    );
  }
}

function getOwnerResumeToken(
  session: SharedSession,
  suppliedToken: string | undefined,
): string | undefined {
  return secureTokenMatches(suppliedToken, session.resumeToken)
    ? session.resumeToken
    : undefined;
}

function canJoinSession(
  session: SharedSession,
  ownerResumeToken: string | undefined,
): boolean {
  return session.accepting || ownerResumeToken !== undefined;
}

/**
 * Get platform default shell
 */
function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

/**
 * Terminal server options
 */
export interface TerminalServerOptions extends ServerConfig {
  /** WebSocket path (default: '/terminal') */
  path?: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Path to Docker CLI (default: 'docker') */
  dockerPath?: string;
  /**
   * Exact browser origins allowed to connect. An empty list preserves the
   * permissive default; production deployments must authenticate upstream or
   * provide `authorize` because an origin check is not authentication.
   */
  allowedOrigins?: string[];
  /**
   * Optional connection authorization policy, evaluated before node-pty is
   * loaded or server metadata is sent. Throwing safely denies the connection.
   */
  authorize?: (request: IncomingMessage) => boolean | Promise<boolean>;
  /** Maximum frames buffered while `authorize` is pending (default: 32, minimum: 0) */
  maxPreAuthMessages?: number;
  /** Maximum frame bytes buffered while `authorize` is pending (default: 65536, minimum: 0) */
  maxPreAuthBytes?: number;
  /** Maximum bytes accepted in one WebSocket request (default: 1048576, minimum: 1) */
  maxMessageBytes?: number;
  /** Maximum queued output per WebSocket client (default: 1048576 bytes) */
  maxBufferedOutputBytes?: number;
  /** Interval for enforcing idle timeouts (default: 60000 ms, max: 2147483647) */
  cleanupInterval?: number;

  // Session multiplexing options
  /**
   * Maximum clients per session (default: 10). Sessions are private unless a
   * spawn explicitly opts into sharing with `allowJoin: true`.
   */
  maxClientsPerSession?: number;
  /** Orphan session timeout in ms (default: 60000, max: 2147483647) */
  orphanTimeout?: number;
  /** History buffer size in characters (default: 50000, 0 disables retention) */
  historySize?: number;
  /** Enable session history (default: true) */
  historyEnabled?: boolean;
  /** Maximum total sessions (default: 100, minimum: 1) */
  maxSessionsTotal?: number;
}

/**
 * Terminal server class with session multiplexing support.
 *
 * @remarks
 * Spawned sessions are private by default. Set `TerminalOptions.allowJoin` to
 * `true` only when terminal sharing is an intentional, authorized feature.
 */
export class TerminalServer {
  private config: Required<TerminalServerOptions>;
  private sessionManager: SessionManager;
  private wss: WebSocketServer | null = null;
  private pty: PtyModule | null = null;
  private ptyInitialization: Promise<void> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private clientIds = new WeakMap<WebSocket, string>();
  private connections = new Set<WebSocket>();
  private containerListInFlight: Promise<ContainerInfo[]> | null = null;
  private containerListCache: {
    containers: ContainerInfo[];
    expiresAt: number;
  } | null = null;
  private closed = false;
  private readonly containerMatchers: RegExp[];

  constructor(options: TerminalServerOptions = {}) {
    const runtimeOptions: unknown = options;
    if (!isJsonObject(runtimeOptions)) {
      throw new TypeError('TerminalServer options must be an object');
    }
    assertKnownKeys(
      runtimeOptions,
      TERMINAL_SERVER_OPTION_KEYS,
      'TerminalServer options',
    );
    validateTerminalServerOptionTypes(options);

    const maxPreAuthMessages = resolveSafeIntegerOption(
      options.maxPreAuthMessages,
      DEFAULT_MAX_PRE_AUTH_MESSAGES,
      'maxPreAuthMessages',
      0,
    );
    const maxPreAuthBytes = resolveSafeIntegerOption(
      options.maxPreAuthBytes,
      DEFAULT_MAX_PRE_AUTH_BYTES,
      'maxPreAuthBytes',
      0,
    );
    const cleanupInterval = resolveSafeIntegerOption(
      options.cleanupInterval,
      60_000,
      'cleanupInterval',
      1,
      MAX_TIMER_DELAY_MS,
    );
    const maxMessageBytes = resolveSafeIntegerOption(
      options.maxMessageBytes,
      DEFAULT_MAX_MESSAGE_BYTES,
      'maxMessageBytes',
      1,
    );
    const maxBufferedOutputBytes = resolveSafeIntegerOption(
      options.maxBufferedOutputBytes,
      DEFAULT_MAX_BUFFERED_OUTPUT_BYTES,
      'maxBufferedOutputBytes',
      1,
    );

    this.config = {
      allowedShells: [...(options.allowedShells ?? [getDefaultShell()])],
      allowedPaths: [...(options.allowedPaths ?? [os.homedir()])],
      defaultShell: options.defaultShell ?? getDefaultShell(),
      defaultCwd: options.defaultCwd ?? os.homedir(),
      maxSessionsPerClient: resolveSafeIntegerOption(
        options.maxSessionsPerClient,
        5,
        'maxSessionsPerClient',
        1,
      ),
      idleTimeout: resolveSafeIntegerOption(
        options.idleTimeout,
        30 * 60 * 1000,
        'idleTimeout',
        0,
      ), // 30 minutes; 0 disables idle cleanup
      allowLocalExec: options.allowLocalExec ?? true,
      path: options.path ?? '/terminal',
      verbose: options.verbose ?? false,
      // Docker options
      allowDockerExec: options.allowDockerExec ?? false,
      allowedContainerPatterns: [...(options.allowedContainerPatterns ?? [])],
      defaultContainerShell: options.defaultContainerShell ?? '/bin/bash',
      dockerPath: options.dockerPath ?? 'docker',
      allowedOrigins: [...(options.allowedOrigins ?? [])],
      authorize: options.authorize ?? (() => true),
      maxPreAuthMessages,
      maxPreAuthBytes,
      maxMessageBytes,
      maxBufferedOutputBytes,
      cleanupInterval,
      // Multiplexing options
      maxClientsPerSession: resolveSafeIntegerOption(
        options.maxClientsPerSession,
        10,
        'maxClientsPerSession',
        1,
      ),
      orphanTimeout: resolveSafeIntegerOption(
        options.orphanTimeout,
        60_000,
        'orphanTimeout',
        0,
        MAX_TIMER_DELAY_MS,
      ),
      historySize: resolveSafeIntegerOption(
        options.historySize,
        50_000,
        'historySize',
        0,
      ),
      historyEnabled: options.historyEnabled ?? true,
      maxSessionsTotal: resolveSafeIntegerOption(
        options.maxSessionsTotal,
        100,
        'maxSessionsTotal',
        1,
      ),
    };
    this.containerMatchers = this.config.allowedContainerPatterns.map(
      compileContainerMatcher,
    );

    // Initialize session manager
    this.sessionManager = new SessionManager({
      maxClientsPerSession: this.config.maxClientsPerSession,
      orphanTimeout: this.config.orphanTimeout,
      historySize: this.config.historySize,
      historyEnabled: this.config.historyEnabled,
      maxSessionsTotal: this.config.maxSessionsTotal,
      maxBufferedOutputBytes: this.config.maxBufferedOutputBytes,
      verbose: this.config.verbose,
    });

    // Handle session manager events
    this.sessionManager.on(
      'sessionClosed',
      (sessionId: string, reason: string) => {
        this.log(`Session ${sessionId} closed: ${reason}`);
      },
    );

    // Start cleanup interval for idle sessions
    this.cleanupInterval = setInterval(
      () => this.cleanupSessions(),
      this.config.cleanupInterval,
    );
    this.cleanupInterval.unref();
  }

  /**
   * Generate a unique client ID
   */
  private generateClientId(): string {
    return `client-${randomUUID()}`;
  }

  /**
   * Get or create client ID for a WebSocket
   */
  private getClientId(ws: WebSocket): string {
    let clientId = this.clientIds.get(ws);
    if (!clientId) {
      clientId = this.generateClientId();
      this.clientIds.set(ws, clientId);
    }
    return clientId;
  }

  /**
   * Initialize node-pty (lazy load)
   */
  private async initPty(): Promise<void> {
    if (this.pty) return;
    if (this.ptyInitialization) return this.ptyInitialization;

    this.ptyInitialization = import('node-pty')
      .then((module) => {
        this.pty = module;
      })
      .catch((error: unknown) => {
        this.ptyInitialization = null;
        throw new Error(
          'node-pty is required for lit-shell. Install it with: npm install node-pty@1.2.0-beta.14',
          { cause: error },
        );
      });

    return this.ptyInitialization;
  }

  /**
   * Attach to an existing HTTP server
   */
  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({
      server,
      path: this.config.path,
      maxPayload: this.config.maxMessageBytes,
    });

    this.setupWebSocketServer();
    this.log(`Terminal WebSocket server listening on ${this.config.path}`);
  }

  /**
   * Start standalone WebSocket server
   */
  listen(port: number): void {
    this.wss = new WebSocketServer({
      port,
      maxPayload: this.config.maxMessageBytes,
    });
    this.setupWebSocketServer();
    this.log(`Terminal WebSocket server listening on port ${port}`);
  }

  /**
   * Setup WebSocket server event handlers
   */
  private setupWebSocketServer(): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws, req) => {
      this.log(`Client connected from ${req.socket.remoteAddress}`);
      void this.handleConnection(ws, req).catch((error: unknown) => {
        this.log(`Failed to initialize connection: ${String(error)}`, 'error');
        this.sendError(ws, 'Failed to initialize terminal connection');
        ws.close(1011, 'Terminal initialization failed');
      });
    });
  }

  /**
   * Handle WebSocket connection
   * Can be called directly for manual WebSocket upgrade handling
   */
  async handleConnection(
    ws: WebSocket,
    request: IncomingMessage,
  ): Promise<void> {
    const clientId = this.getClientId(ws);
    this.connections.add(ws);
    this.log(`Assigned client ID: ${clientId}`);

    let connectionReadyComplete = false;
    let preAuthRejected = false;
    let preAuthMessages = 0;
    let preAuthBytes = 0;
    let rejectPreAuthLimit!: (error: ConnectionPolicyError) => void;
    const preAuthLimit = new Promise<never>((_resolve, reject) => {
      rejectPreAuthLimit = reject;
    });

    // Start policy evaluation without yielding. Socket listeners are installed
    // before its promise can settle or PTY initialization can receive frames.
    const authorizationReady = this.authorizeConnection(request);
    const connectionReady = Promise.race([authorizationReady, preAuthLimit])
      .then(() => this.initPty())
      .then(() => {
        connectionReadyComplete = true;
        preAuthMessages = 0;
        preAuthBytes = 0;
      });
    let messageQueue = Promise.resolve();

    ws.on('message', (data) => {
      if (preAuthRejected) return;

      const messageBytes = acceptedMessageBytes(
        ws,
        data,
        this.config.maxMessageBytes,
      );
      if (messageBytes === undefined) {
        preAuthRejected = true;
        return;
      }

      // Bound everything retained before the connection is usable, including
      // frames received while the native PTY runtime is loading.
      if (!connectionReadyComplete) {
        preAuthMessages += 1;
        preAuthBytes += messageBytes;
        if (
          preAuthMessages > this.config.maxPreAuthMessages ||
          preAuthBytes > this.config.maxPreAuthBytes
        ) {
          preAuthRejected = true;
          rejectPreAuthLimit(new ConnectionPolicyError(PRE_AUTH_LIMIT_ERROR));
          closeOpenWebSocket(ws, 1008, PRE_AUTH_LIMIT_ERROR);
          return;
        }
      }

      messageQueue = messageQueue
        .then(async () => {
          try {
            await connectionReady;
          } catch {
            return;
          }
          this.handleIncomingMessage(ws, clientId, rawDataToString(data));
        })
        .catch((error: unknown) => {
          this.log(
            `Failed to handle client message: ${String(error)}`,
            'error',
          );
          this.sendError(ws, 'Failed to process request');
        });
    });

    ws.on('close', () => this.handleClientDisconnect(ws, clientId));

    ws.on('error', (error) => {
      this.log(
        `WebSocket error for client ${clientId}: ${error.message}`,
        'error',
      );
    });

    try {
      await connectionReady;
    } catch (error) {
      this.handleConnectionFailure(ws, error);
      return;
    }

    if (!this.closed && ws.readyState === WebSocket.OPEN)
      this.sendServerInfo(ws);
  }

  private handleClientDisconnect(ws: WebSocket, clientId: string): void {
    this.connections.delete(ws);
    this.log(`Client ${clientId} disconnected`);
    const affectedSessions =
      this.sessionManager.removeClientFromAllSessions(clientId);
    if (affectedSessions.length > 0) {
      this.log(`Removed client from sessions: ${affectedSessions.join(', ')}`);
    }
  }

  private handleConnectionFailure(ws: WebSocket, error: unknown): void {
    if (error instanceof ConnectionPolicyError) {
      closeOpenWebSocket(ws, 1008, connectionPolicyCloseReason(error));
      return;
    }
    this.sendError(ws, error instanceof Error ? error.message : String(error));
    closeOpenWebSocket(ws, 1011, 'node-pty unavailable');
  }

  private async authorizeConnection(request: IncomingMessage): Promise<void> {
    if (this.closed) throw new ConnectionPolicyError('Server is closed');

    if (this.config.allowedOrigins.length > 0) {
      const origin = request.headers.origin;
      if (!origin || !this.config.allowedOrigins.includes(origin)) {
        throw new ConnectionPolicyError('Origin is not allowed');
      }
    }

    let authorized: boolean;
    try {
      authorized = (await this.config.authorize(request)) === true;
    } catch {
      this.log('Connection authorization hook failed', 'error');
      throw new ConnectionPolicyError('Authorization policy failed');
    }
    if (!authorized)
      throw new ConnectionPolicyError('Connection is not authorized');
    // The server can be closed by another task while the async hook is pending.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.closed) throw new ConnectionPolicyError('Server is closed');
  }

  /**
   * Parse, validate, and dispatch one client request.
   */
  private handleIncomingMessage(
    ws: WebSocket,
    clientId: string,
    raw: string,
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      this.sendError(ws, 'Invalid JSON request');
      return;
    }

    if (!isJsonObject(parsed)) {
      this.sendError(ws, 'Protocol request must be a JSON object');
      return;
    }

    const requestIdValue = parsed.requestId;
    if (requestIdValue !== undefined && typeof requestIdValue !== 'string') {
      this.sendError(ws, 'requestId must be a string');
      return;
    }
    const requestId = requestIdValue;

    if (!isNonEmptyString(parsed.type)) {
      this.sendError(ws, 'Request type must be a non-empty string', {
        requestId,
      });
      return;
    }

    try {
      switch (parsed.type) {
        case 'spawn': {
          const options = this.validateTerminalOptions(parsed.options);
          this.spawnSession(ws, clientId, options, requestId);
          return;
        }
        case 'data': {
          const sessionId = this.requireSessionId(parsed);
          if (typeof parsed.data !== 'string') {
            throw new Error('data must be a string');
          }
          this.writeToSession(ws, sessionId, clientId, parsed.data, requestId);
          return;
        }
        case 'resize': {
          const sessionId = this.requireSessionId(parsed);
          if (
            !isSafeIntegerInRange(parsed.cols, 1, MAX_TERMINAL_COLUMNS) ||
            !isSafeIntegerInRange(parsed.rows, 1, MAX_TERMINAL_ROWS)
          ) {
            throw new Error(
              `cols and rows must be safe integers between 1 and ` +
                `${MAX_TERMINAL_COLUMNS}/${MAX_TERMINAL_ROWS}, respectively`,
            );
          }
          this.resizeSession(
            ws,
            sessionId,
            clientId,
            parsed.cols,
            parsed.rows,
            requestId,
          );
          return;
        }
        case 'close': {
          const sessionId = this.requireSessionId(parsed);
          this.closeSession(ws, sessionId, clientId, requestId);
          return;
        }
        case 'listContainers':
          this.listContainers(ws, requestId);
          return;
        case 'listSessions': {
          const filter = this.validateSessionFilter(parsed.filter);
          this.handleListSessions(ws, clientId, filter, requestId);
          return;
        }
        case 'join': {
          const options = this.validateJoinOptions(parsed.options);
          this.handleJoinSession(ws, clientId, options, requestId);
          return;
        }
        case 'leave': {
          const sessionId = this.requireSessionId(parsed);
          this.handleLeaveSession(ws, clientId, sessionId, requestId);
          return;
        }
        default:
          this.sendError(ws, `Unknown request type: ${parsed.type}`, {
            requestId,
          });
      }
    } catch (error) {
      this.sendError(ws, (error as Error).message, {
        requestId,
        sessionId:
          typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
      });
    }
  }

  private requireSessionId(message: JsonObject): string {
    if (!isNonEmptyString(message.sessionId)) {
      throw new Error('sessionId must be a non-empty string');
    }
    return message.sessionId;
  }

  private validateTerminalOptions(value: unknown): TerminalOptions {
    if (value === undefined) return {};
    if (!isJsonObject(value)) {
      throw new Error('spawn options must be an object');
    }
    assertKnownKeys(value, TERMINAL_OPTION_KEYS, 'spawn options');

    this.validateOptionalString(value.shell, 'shell');
    this.validateOptionalString(value.cwd, 'cwd');
    this.validateOptionalString(value.container, 'container');
    this.validateOptionalString(value.containerShell, 'containerShell');
    this.validateOptionalString(value.containerUser, 'containerUser');
    this.validateOptionalString(value.containerCwd, 'containerCwd');
    this.validateOptionalString(value.label, 'label');
    this.validateOptionalString(value.tmuxSession, 'tmuxSession');
    this.validateOptionalTerminalDimension(
      value.cols,
      'cols',
      MAX_TERMINAL_COLUMNS,
    );
    this.validateOptionalTerminalDimension(
      value.rows,
      'rows',
      MAX_TERMINAL_ROWS,
    );
    this.validateOptionalBoolean(value.attachMode, 'attachMode');
    this.validateOptionalBoolean(value.allowJoin, 'allowJoin');
    this.validateOptionalBoolean(value.enableHistory, 'enableHistory');
    this.validateOptionalBoolean(value.useTmux, 'useTmux');

    assertTerminalOptionCompatibility(value);

    if (
      typeof value.container === 'string' &&
      !DOCKER_CONTAINER_IDENTIFIER_PATTERN.test(value.container)
    ) {
      throw new Error('container must be a valid Docker container name or ID');
    }
    if (
      typeof value.containerUser === 'string' &&
      !isValidContainerUser(value.containerUser)
    ) {
      throw new Error('containerUser must be a valid user or user:group');
    }
    if (
      typeof value.containerCwd === 'string' &&
      (!path.posix.isAbsolute(value.containerCwd) ||
        value.containerCwd.includes('\0'))
    ) {
      throw new Error('containerCwd must be an absolute POSIX path');
    }

    if (
      value.orphanTimeout !== undefined &&
      !isSafeIntegerInRange(value.orphanTimeout, 0, MAX_TIMER_DELAY_MS)
    ) {
      throw new Error(
        `orphanTimeout must be a safe integer between 0 and ${MAX_TIMER_DELAY_MS}`,
      );
    }

    if (value.env !== undefined) {
      if (!isJsonObject(value.env)) {
        throw new Error('env must be an object of string values');
      }
      for (const [key, environmentValue] of Object.entries(value.env)) {
        if (typeof environmentValue !== 'string') {
          throw new Error('env must be an object of string values');
        }
        if (!PORTABLE_ENVIRONMENT_KEY_PATTERN.test(key)) {
          throw new Error('env keys must use portable identifier syntax');
        }
        if (environmentValue.includes('\0')) {
          throw new Error('env values must not contain NUL bytes');
        }
      }
    }

    return value;
  }

  private validateOptionalString(
    value: unknown,
    name: string,
  ): asserts value is string | undefined {
    if (value !== undefined && !isNonEmptyString(value)) {
      throw new Error(`${name} must be a non-empty string`);
    }
  }

  private validateOptionalTerminalDimension(
    value: unknown,
    name: string,
    maximum: number,
  ): void {
    if (value !== undefined && !isSafeIntegerInRange(value, 1, maximum)) {
      throw new Error(
        `${name} must be a safe integer between 1 and ${maximum}`,
      );
    }
  }

  private validateOptionalBoolean(value: unknown, name: string): void {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`${name} must be a boolean`);
    }
  }

  private validateSessionFilter(value: unknown): SessionListFilter | undefined {
    if (value === undefined) return undefined;
    if (!isJsonObject(value)) {
      throw new Error('filter must be an object');
    }
    assertKnownKeys(value, SESSION_FILTER_KEYS, 'filter');
    if (
      value.type !== undefined &&
      value.type !== 'local' &&
      value.type !== 'docker-exec' &&
      value.type !== 'docker-attach'
    ) {
      throw new Error('filter.type is invalid');
    }
    if (value.container !== undefined && !isNonEmptyString(value.container)) {
      throw new Error('filter.container must be a non-empty string');
    }
    if (value.accepting !== undefined && typeof value.accepting !== 'boolean') {
      throw new Error('filter.accepting must be a boolean');
    }
    return value;
  }

  private validateJoinOptions(value: unknown): {
    sessionId: string;
    requestHistory?: boolean;
    historyLimit?: number;
    resumeToken?: string;
  } {
    if (!isJsonObject(value)) {
      throw new Error('join options must be an object');
    }
    assertKnownKeys(value, JOIN_OPTION_KEYS, 'join options');
    if (!isNonEmptyString(value.sessionId)) {
      throw new Error('join options.sessionId must be a non-empty string');
    }
    if (
      value.requestHistory !== undefined &&
      typeof value.requestHistory !== 'boolean'
    ) {
      throw new Error('requestHistory must be a boolean');
    }
    if (
      value.historyLimit !== undefined &&
      !isSafeIntegerInRange(value.historyLimit, 0, this.config.historySize)
    ) {
      throw new Error(
        `historyLimit must be a safe integer between 0 and ${this.config.historySize}`,
      );
    }
    const resumeToken = value.resumeToken;
    this.validateOptionalString(resumeToken, 'resumeToken');
    return {
      sessionId: value.sessionId,
      requestHistory: value.requestHistory,
      historyLimit: value.historyLimit,
      resumeToken,
    };
  }

  // ===========================================================================
  // Session Multiplexing Handlers
  // ===========================================================================

  /**
   * Handle list sessions request
   */
  private handleListSessions(
    ws: WebSocket,
    clientId: string,
    filter: SessionListFilter | undefined,
    requestId: RequestId | undefined,
  ): void {
    const sessions = this.sessionManager
      .getSessions(filter)
      .filter(
        (session) =>
          session.accepting ||
          session.owner === clientId ||
          session.clients.has(clientId),
      );
    const sessionInfos: SharedSessionInfo[] = sessions.map((s) =>
      this.sessionManager.toSharedSessionInfo(s),
    );

    this.log(
      `Listed ${sessions.length} sessions: ${sessions.map((s) => s.id).join(', ')}`,
    );

    this.sendResponse(
      ws,
      { type: 'sessionList', sessions: sessionInfos },
      requestId,
    );
  }

  /**
   * Handle join session request
   */
  private handleJoinSession(
    ws: WebSocket,
    clientId: string,
    options: {
      sessionId: string;
      requestHistory?: boolean;
      historyLimit?: number;
      resumeToken?: string;
    },
    requestId: RequestId | undefined,
  ): void {
    this.log(
      `Client ${clientId} attempting to join session: ${options.sessionId}`,
    );
    const session = this.sessionManager.getSession(options.sessionId);

    if (!session) {
      const allSessions = this.sessionManager.getSessions();
      this.log(
        `Session not found: ${options.sessionId}. Available sessions: ${allSessions.map((s) => s.id).join(', ') || 'none'}`,
        'warn',
      );
      this.sendError(ws, `Session not found: ${options.sessionId}`, {
        requestId,
        sessionId: options.sessionId,
      });
      return;
    }

    const ownerResumeToken = getOwnerResumeToken(session, options.resumeToken);
    if (!canJoinSession(session, ownerResumeToken)) {
      this.sendError(ws, 'Session is not accepting new clients', {
        requestId,
        sessionId: options.sessionId,
      });
      return;
    }

    this.assertClientSessionCapacity(session, clientId);

    // Add client to session
    const success = this.sessionManager.addClient(
      options.sessionId,
      clientId,
      ws,
      options.resumeToken,
    );
    if (!success) {
      this.sendError(ws, `Failed to join session: ${options.sessionId}`, {
        requestId,
        sessionId: options.sessionId,
      });
      return;
    }

    // Get history if requested
    let history: string | undefined;
    if (options.requestHistory && session.historyEnabled) {
      history = this.sessionManager.getHistory(
        options.sessionId,
        options.historyLimit,
      );
    }

    // Send joined response
    this.sendResponse(
      ws,
      {
        type: 'joined',
        sessionId: options.sessionId,
        session: this.sessionManager.toSharedSessionInfo(session),
        history,
        resumeToken: ownerResumeToken,
      },
      requestId,
    );

    // Broadcast to other clients
    this.sessionManager.broadcastToSession(
      options.sessionId,
      {
        type: 'clientJoined',
        sessionId: options.sessionId,
        clientCount: session.clients.size,
      },
      clientId,
    );

    this.log(`Client ${clientId} joined session ${options.sessionId}`);
  }

  /**
   * Handle leave session request
   */
  private handleLeaveSession(
    ws: WebSocket,
    clientId: string,
    sessionId: string,
    requestId: RequestId | undefined,
  ): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      this.sendError(ws, `Session not found: ${sessionId}`, {
        requestId,
        sessionId,
      });
      return;
    }

    if (!this.sessionManager.isClientInSession(sessionId, clientId)) {
      this.sendError(ws, `Client is not a member of session: ${sessionId}`, {
        requestId,
        sessionId,
      });
      return;
    }

    // Remove client from session
    this.sessionManager.removeClient(sessionId, clientId);

    // Send left response
    this.sendResponse(ws, { type: 'left', sessionId }, requestId);

    // Broadcast to remaining clients
    if (this.sessionManager.hasSession(sessionId)) {
      const updatedSession = this.sessionManager.getSession(sessionId)!;
      this.sessionManager.broadcastToSession(sessionId, {
        type: 'clientLeft',
        sessionId,
        clientCount: updatedSession.clients.size,
      });
    }

    this.log(`Client ${clientId} left session ${sessionId}`);
  }

  // ===========================================================================
  // Validation Methods
  // ===========================================================================

  /**
   * Validate shell path
   */
  private isShellAllowed(shell: string): boolean {
    if (this.config.allowedShells.length === 0) return true;

    const normalize = (value: string): string => {
      const normalized = path.normalize(value);
      return process.platform === 'win32'
        ? normalized.toLowerCase()
        : normalized;
    };
    const normalizedShell = normalize(shell);
    return this.config.allowedShells.some(
      (allowedShell) => normalizedShell === normalize(allowedShell),
    );
  }

  /**
   * Validate working directory
   */
  private isCwdAllowed(cwd: string): boolean {
    if (this.config.allowedPaths.length === 0) return true;

    let canonicalCwd: string;
    try {
      // The requested path is intentionally resolved for containment checking.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      canonicalCwd = realpathSync(cwd);
    } catch {
      return false;
    }

    return this.config.allowedPaths.some((allowedPath) => {
      try {
        // Allowed paths are administrator-provided configuration.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const canonicalAllowed = realpathSync(allowedPath);
        const relative = path.relative(canonicalAllowed, canonicalCwd);
        return (
          relative === '' ||
          (!relative.startsWith(`..${path.sep}`) &&
            relative !== '..' &&
            !path.isAbsolute(relative))
        );
      } catch {
        return false;
      }
    });
  }

  /**
   * Validate container name/ID against allowed patterns
   */
  private isContainerAllowed(container: string): boolean {
    // Docker exec must be enabled
    if (!this.config.allowDockerExec) return false;

    // If no patterns are specified, all syntactically valid containers are
    // allowed when Docker exec is enabled.
    if (this.containerMatchers.length === 0) return true;

    return this.containerMatchers.some((matcher) => matcher.test(container));
  }

  // ===========================================================================
  // Session Spawning
  // ===========================================================================

  /**
   * Spawn a Docker exec session
   */
  private spawnDockerExecSession(
    ws: WebSocket,
    clientId: string,
    options: TerminalOptions,
    sessionId: string,
    requestId: RequestId | undefined,
  ): SharedSession | null {
    const container = options.container!;
    const shell = options.containerShell ?? this.config.defaultContainerShell;
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;

    // Build docker exec args
    const args = ['exec', '-it'];

    // Add user if specified
    if (options.containerUser) {
      args.push('-u', options.containerUser);
    }

    // Add working directory if specified
    if (options.containerCwd) {
      args.push('-w', options.containerCwd);
    }

    // Add environment variables
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    // Add container
    args.push(container);

    // Check if tmux mode is enabled
    if (options.useTmux) {
      // Use tmux for persistent session
      // tmux new-session -A -s <name> means "attach if exists, create if not"
      const tmuxSessionName =
        options.tmuxSession ?? `ls-${sessionId.substring(0, 8)}`;
      args.push('tmux', 'new-session', '-A', '-s', tmuxSessionName);
      this.log(`Spawning Docker exec with tmux in container ${container}`);
    } else {
      // Regular shell
      args.push(shell);
      this.log(`Spawning Docker exec in container ${container}`);
    }

    let ptyProcess: TerminalProcess | null = null;
    try {
      if (!this.pty) throw new Error('Terminal runtime is not initialized');
      // Spawn PTY with docker exec
      ptyProcess = this.pty.spawn(this.config.dockerPath, args, {
        name: 'xterm-256color',
        cols,
        rows,
        env: process.env,
      });

      // Create session via SessionManager
      const session = this.sessionManager.createSession({
        id: sessionId,
        type: 'docker-exec',
        pty: ptyProcess,
        shell: options.useTmux ? 'tmux' : shell,
        cwd: options.containerCwd ?? '/',
        cols,
        rows,
        ownerId: clientId,
        ownerWs: ws,
        container,
        label: options.label,
        allowJoin: options.allowJoin,
        enableHistory: options.enableHistory,
        orphanTimeout:
          options.orphanTimeout === 0 ? undefined : options.orphanTimeout,
        useTmux: options.useTmux,
      });

      return session;
    } catch (error) {
      this.cleanupFailedSpawn(sessionId, ptyProcess);
      this.log(`Failed to spawn Docker exec: ${String(error)}`, 'error');
      this.sendError(
        ws,
        `Failed to exec into container: ${(error as Error).message}`,
        { sessionId, requestId },
      );
      return null;
    }
  }

  /**
   * Spawn a Docker attach session (connects to container's main process)
   */
  private spawnDockerAttachSession(
    ws: WebSocket,
    clientId: string,
    options: TerminalOptions,
    sessionId: string,
    requestId: RequestId | undefined,
  ): SharedSession | null {
    const container = options.container!;
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;

    // Build docker attach args
    // --sig-proxy=false prevents signals from being proxied to the container
    // --detach-keys allows detaching without killing the session
    const args = [
      'attach',
      '--sig-proxy=false',
      '--detach-keys=ctrl-p,ctrl-q',
      container,
    ];

    this.log(`Spawning Docker attach to container ${container}`);

    let ptyProcess: TerminalProcess | null = null;
    try {
      if (!this.pty) throw new Error('Terminal runtime is not initialized');
      // Spawn PTY with docker attach
      ptyProcess = this.pty.spawn(this.config.dockerPath, args, {
        name: 'xterm-256color',
        cols,
        rows,
        env: process.env,
      });

      // Create session via SessionManager
      const session = this.sessionManager.createSession({
        id: sessionId,
        type: 'docker-attach',
        pty: ptyProcess,
        shell: 'attach',
        cwd: '/',
        cols,
        rows,
        ownerId: clientId,
        ownerWs: ws,
        container,
        label: options.label,
        allowJoin: options.allowJoin,
        enableHistory: options.enableHistory,
        orphanTimeout:
          options.orphanTimeout === 0 ? undefined : options.orphanTimeout,
      });

      return session;
    } catch (error) {
      this.cleanupFailedSpawn(sessionId, ptyProcess);
      this.log(`Failed to spawn Docker attach: ${String(error)}`, 'error');
      this.sendError(
        ws,
        `Failed to attach to container: ${(error as Error).message}`,
        { sessionId, requestId },
      );
      return null;
    }
  }

  /**
   * Spawn a new terminal session
   */
  private spawnSession(
    ws: WebSocket,
    clientId: string,
    options: TerminalOptions,
    requestId: RequestId | undefined,
  ): void {
    this.assertExecutionModeAllowed(options);

    // Check client session limit
    if (this.clientSessionLimitReached(clientId)) {
      this.sendError(
        ws,
        `Maximum sessions (${this.config.maxSessionsPerClient}) reached`,
        { requestId },
      );
      return;
    }

    // Enforce the global limit before creating an operating-system process.
    if (!this.sessionManager.canCreateSession()) {
      this.sendError(ws, 'Maximum number of sessions reached', { requestId });
      return;
    }

    const sessionId = `term-${randomUUID()}`;

    // Check if this is a Docker request
    if (options.container) {
      // Validate container access
      if (!this.isContainerAllowed(options.container)) {
        this.sendError(
          ws,
          `Container access not allowed: ${options.container}. Docker exec ${this.config.allowDockerExec ? 'is enabled but container pattern not matched' : 'is disabled'}.`,
          { requestId },
        );
        return;
      }

      let session: SharedSession | null;

      // Check if attach mode requested
      if (options.attachMode) {
        session = this.spawnDockerAttachSession(
          ws,
          clientId,
          options,
          sessionId,
          requestId,
        );
      } else {
        session = this.spawnDockerExecSession(
          ws,
          clientId,
          options,
          sessionId,
          requestId,
        );
      }

      if (!session) return;

      this.setupSessionHandlers(session);

      // Notify client
      this.sendResponse(
        ws,
        {
          type: 'spawned',
          sessionId,
          shell: session.shell,
          cwd: session.cwd,
          cols: session.cols,
          rows: session.rows,
          container: session.container,
          resumeToken: session.resumeToken,
        },
        requestId,
      );

      this.log(
        `Docker ${options.attachMode ? 'attach' : 'exec'} session spawned: ${sessionId} (container: ${session.container})`,
      );
      return;
    }

    // Regular local shell session
    const shell = options.shell ?? this.config.defaultShell;
    const cwd = options.cwd ?? this.config.defaultCwd;
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    const env = options.env ?? {};

    // Validate shell
    if (!this.isShellAllowed(shell)) {
      this.sendError(
        ws,
        `Shell not allowed: ${shell}. Allowed: ${this.config.allowedShells.join(', ')}`,
        { requestId },
      );
      return;
    }

    // Validate cwd
    if (!this.isCwdAllowed(cwd)) {
      this.sendError(ws, `Working directory not allowed: ${cwd}`, {
        requestId,
      });
      return;
    }

    let ptyProcess: TerminalProcess | null = null;
    try {
      if (!this.pty) throw new Error('Terminal runtime is not initialized');
      // Spawn PTY
      ptyProcess = this.pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...process.env, ...env },
      });

      // Create session via SessionManager
      const session = this.sessionManager.createSession({
        id: sessionId,
        type: 'local',
        pty: ptyProcess,
        shell,
        cwd,
        cols,
        rows,
        ownerId: clientId,
        ownerWs: ws,
        label: options.label,
        allowJoin: options.allowJoin,
        enableHistory: options.enableHistory,
        orphanTimeout:
          options.orphanTimeout === 0 ? undefined : options.orphanTimeout,
      });

      this.setupSessionHandlers(session);

      // Notify client
      this.sendResponse(
        ws,
        {
          type: 'spawned',
          sessionId,
          shell,
          cwd,
          cols,
          rows,
          resumeToken: session.resumeToken,
        },
        requestId,
      );

      this.log(`Session spawned: ${sessionId} (shell: ${shell}, cwd: ${cwd})`);
    } catch (error) {
      this.cleanupFailedSpawn(sessionId, ptyProcess);
      this.log(`Failed to spawn session: ${String(error)}`, 'error');
      this.sendError(ws, (error as Error).message, { requestId, sessionId });
    }
  }

  private assertExecutionModeAllowed(options: TerminalOptions): void {
    if (options.container === undefined && !this.config.allowLocalExec) {
      throw new Error('Local terminal execution is disabled');
    }
  }

  private clientSessionLimitReached(clientId: string): boolean {
    return (
      this.sessionManager.getClientSessions(clientId).length >=
      this.config.maxSessionsPerClient
    );
  }

  private assertClientSessionCapacity(
    session: SharedSession,
    clientId: string,
  ): void {
    if (
      !session.clients.has(clientId) &&
      this.clientSessionLimitReached(clientId)
    ) {
      throw new Error(
        `Maximum sessions (${this.config.maxSessionsPerClient}) reached`,
      );
    }
  }

  private killPtySafely(ptyProcess: TerminalProcess | null): void {
    if (!ptyProcess) return;
    try {
      ptyProcess.kill();
    } catch (error) {
      this.log(`Failed to clean up PTY: ${String(error)}`, 'warn');
    }
  }

  private cleanupFailedSpawn(
    sessionId: string,
    ptyProcess: TerminalProcess | null,
  ): void {
    if (this.sessionManager.hasSession(sessionId)) {
      this.sessionManager.closeSession(sessionId, 'error');
      return;
    }
    this.killPtySafely(ptyProcess);
  }

  /**
   * Setup PTY event handlers for a session
   */
  private setupSessionHandlers(session: SharedSession): void {
    const sessionId = session.id;

    // Handle PTY output
    session.pty.onData((data: string) => {
      // Update activity
      this.sessionManager.updateSessionActivity(sessionId);

      // Store in history buffer
      this.sessionManager.appendHistory(sessionId, data);

      // Broadcast to all connected clients
      this.sessionManager.broadcastToSession(sessionId, {
        type: 'data',
        sessionId,
        data,
      });
    });

    // Handle PTY exit
    session.pty.onExit(({ exitCode }: { exitCode: number }) => {
      // Broadcast exit to all clients
      this.sessionManager.broadcastToSession(sessionId, {
        type: 'exit',
        sessionId,
        exitCode,
      });

      // Also broadcast session closed
      this.sessionManager.broadcastToSession(sessionId, {
        type: 'sessionClosed',
        sessionId,
        reason: 'process_exit',
      });

      // Close the session
      this.sessionManager.closeSession(sessionId, 'process_exit');
      this.log(`Session exited: ${sessionId} (code: ${exitCode})`);
    });
  }

  /**
   * Write data to session
   */
  private writeToSession(
    ws: WebSocket,
    sessionId: string,
    clientId: string,
    data: string,
    requestId: RequestId | undefined,
  ): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      this.log(`Session not found: ${sessionId}`, 'warn');
      this.sendError(ws, `Session not found: ${sessionId}`, {
        requestId,
        sessionId,
      });
      return;
    }

    // Verify client is in session
    if (!this.sessionManager.isClientInSession(sessionId, clientId)) {
      this.log(`Client ${clientId} not in session ${sessionId}`, 'warn');
      this.sendError(ws, `Client is not a member of session: ${sessionId}`, {
        requestId,
        sessionId,
      });
      return;
    }

    this.sessionManager.updateClientActivity(sessionId, clientId);
    session.pty.write(data);
  }

  /**
   * Resize session
   */
  private resizeSession(
    ws: WebSocket,
    sessionId: string,
    clientId: string,
    cols: number,
    rows: number,
    requestId: RequestId | undefined,
  ): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      this.log(`Session not found: ${sessionId}`, 'warn');
      this.sendError(ws, `Session not found: ${sessionId}`, {
        requestId,
        sessionId,
      });
      return;
    }

    if (!this.sessionManager.isClientInSession(sessionId, clientId)) {
      this.log(`Client ${clientId} not in session ${sessionId}`, 'warn');
      this.sendError(ws, `Client is not a member of session: ${sessionId}`, {
        requestId,
        sessionId,
      });
      return;
    }

    this.sessionManager.updateClientActivity(sessionId, clientId);
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
  }

  /**
   * Close session (only owner can close, or force close)
   */
  private closeSession(
    ws: WebSocket,
    sessionId: string,
    clientId: string,
    requestId: RequestId | undefined,
  ): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      this.sendError(ws, `Session not found: ${sessionId}`, {
        requestId,
        sessionId,
      });
      return;
    }

    // Check if client is the owner
    if (session.owner !== clientId) {
      this.log(
        `Client ${clientId} attempted to close session owned by ${session.owner}`,
        'warn',
      );
      this.sendError(
        ws,
        `Only the session owner can close session: ${sessionId}`,
        {
          requestId,
          sessionId,
        },
      );
      return;
    }

    const closedMessage = {
      type: 'sessionClosed',
      sessionId,
      reason: 'owner_closed',
    };
    if (requestId === undefined) {
      this.sessionManager.broadcastToSession(sessionId, closedMessage);
    } else {
      this.sessionManager.broadcastToSession(
        sessionId,
        closedMessage,
        clientId,
      );
      this.sendResponse(ws, closedMessage, requestId);
    }

    // Close the session
    this.sessionManager.closeSession(sessionId, 'owner_closed');
    this.log(`Session closed by owner: ${sessionId}`);
  }

  /**
   * Clean up inactive sessions
   */
  private cleanupSessions(): void {
    if (this.config.idleTimeout === 0) return;

    const now = Date.now();
    for (const session of this.sessionManager.getSessions()) {
      const idleTime = now - session.lastActivity.getTime();
      if (idleTime > this.config.idleTimeout) {
        this.log(`Closing inactive session: ${session.id}`);

        // Broadcast to all clients
        this.sessionManager.broadcastToSession(session.id, {
          type: 'exit',
          sessionId: session.id,
          exitCode: -1,
        });
        this.sessionManager.broadcastToSession(session.id, {
          type: 'sessionClosed',
          sessionId: session.id,
          reason: 'idle_timeout',
        });

        this.sessionManager.closeSession(session.id, 'idle_timeout');
      }
    }
  }

  /**
   * Send error message to client
   */
  private sendError(
    ws: WebSocket,
    error: string,
    context: {
      sessionId?: string;
      requestId?: RequestId;
    } = {},
  ): void {
    this.sendResponse(
      ws,
      {
        type: 'error',
        sessionId: context.sessionId,
        error,
      },
      context.requestId,
    );
  }

  private sendResponse(
    ws: WebSocket,
    response: JsonObject,
    requestId?: RequestId,
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const message =
      requestId === undefined ? response : { ...response, requestId };
    try {
      ws.send(this.serializeBoundedResponse(ws, message));
    } catch (error) {
      this.log(`Failed to send WebSocket response: ${String(error)}`, 'warn');
    }
  }

  private serializeBoundedResponse(ws: WebSocket, message: JsonObject): string {
    const serialized = JSON.stringify(message);
    if (
      canQueueWebSocketMessage(
        ws,
        Buffer.byteLength(serialized),
        this.config.maxBufferedOutputBytes,
      )
    ) {
      return serialized;
    }
    this.disconnectSlowClient(ws);
    throw new Error('Client output buffer limit exceeded');
  }

  private disconnectSlowClient(ws: WebSocket): void {
    const clientId = this.clientIds.get(ws);
    if (clientId !== undefined) {
      this.sessionManager.removeClientFromAllSessions(clientId);
    }
    this.log('Disconnecting slow client: output buffer limit exceeded', 'warn');
    try {
      closeForOutputBackpressure(ws);
    } catch (error) {
      this.log(`Failed to close slow client: ${String(error)}`, 'warn');
      ws.terminate();
    }
  }

  /**
   * Log message
   */
  private log(
    message: string,
    level: 'info' | 'warn' | 'error' = 'info',
  ): void {
    if (!this.config.verbose && level !== 'error') return;

    const prefix = '[lit-shell]';
    switch (level) {
      case 'error':
        console.error(`${prefix} ${message}`);
        break;
      case 'warn':
        console.warn(`${prefix} ${message}`);
        break;
      default:
        console.log(`${prefix} ${message}`);
    }
  }

  /**
   * Send server info to client
   */
  private sendServerInfo(ws: WebSocket): void {
    const info: ServerInfo = {
      localEnabled: this.config.allowLocalExec,
      dockerEnabled: this.config.allowDockerExec,
      allowedShells: this.config.allowedShells,
      defaultShell: this.config.defaultShell,
      defaultContainerShell: this.config.defaultContainerShell,
    };

    this.sendResponse(ws, { type: 'serverInfo', info });
  }

  /**
   * List available Docker containers
   */
  private listContainers(
    ws: WebSocket,
    requestId: RequestId | undefined,
  ): void {
    if (!this.config.allowDockerExec) {
      this.sendResponse(
        ws,
        { type: 'containerList', containers: [] },
        requestId,
      );
      return;
    }

    void this.getContainerList().then(
      (containers) => {
        this.sendResponse(ws, { type: 'containerList', containers }, requestId);
      },
      () => {
        this.sendResponse(
          ws,
          { type: 'containerList', containers: [] },
          requestId,
        );
      },
    );
  }

  private getContainerList(): Promise<ContainerInfo[]> {
    const cached = this.containerListCache;
    if (cached && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.containers);
    }
    if (this.containerListInFlight) return this.containerListInFlight;

    const request = this.queryContainerList();
    this.containerListInFlight = request;
    void request
      .then(
        (containers) => {
          this.containerListCache = {
            containers,
            expiresAt: Date.now() + DOCKER_LIST_CACHE_TTL_MS,
          };
        },
        () => {
          // Negative-cache failures for the same short interval as successes.
          // This bounds both child-process creation and error logging when the
          // Docker daemon or CLI remains unavailable.
          this.containerListCache = {
            containers: [],
            expiresAt: Date.now() + DOCKER_LIST_CACHE_TTL_MS,
          };
        },
      )
      .finally(() => {
        if (this.containerListInFlight === request) {
          this.containerListInFlight = null;
        }
      });
    return request;
  }

  private queryContainerList(): Promise<ContainerInfo[]> {
    return new Promise((resolve, reject) => {
      // Invoke Docker without a shell so a configured executable path is never
      // interpreted as command text. Timeout and output bounds keep a wedged or
      // hostile CLI from retaining a child process or unbounded output.
      execFile(
        this.config.dockerPath,
        [
          'ps',
          '--format',
          '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.State}}',
        ],
        {
          encoding: 'utf8',
          timeout: DOCKER_LIST_TIMEOUT_MS,
          maxBuffer: DOCKER_LIST_MAX_BUFFER_BYTES,
        },
        (error, stdout) => {
          if (error) {
            this.log(`Failed to list containers: ${error.message}`, 'error');
            reject(
              error instanceof Error
                ? error
                : new Error('Failed to list Docker containers'),
            );
            return;
          }

          const containers = this.parseContainerList(stdout);
          this.log(`Listed ${containers.length} containers`);
          resolve(containers);
        },
      );
    });
  }

  private parseContainerList(stdout: string): ContainerInfo[] {
    const containers: ContainerInfo[] = [];
    for (const line of stdout.trim().split('\n')) {
      const container = parseContainerLine(line);
      if (container && this.isContainerVisible(container)) {
        containers.push(container);
      }
    }

    return containers;
  }

  private isContainerVisible(container: ContainerInfo): boolean {
    return (
      this.isContainerAllowed(container.name) ||
      this.isContainerAllowed(container.id)
    );
  }

  /**
   * Get all active sessions (for external access)
   */
  getSessions(): SessionInfo[] {
    return this.sessionManager.getSessions().map((session) => ({
      sessionId: session.id,
      shell: session.shell,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      createdAt: session.createdAt,
      container: session.container,
    }));
  }

  /**
   * Get all active sessions with multiplexing info
   */
  getSharedSessions(filter?: SessionListFilter): SharedSessionInfo[] {
    return this.sessionManager
      .getSessions(filter)
      .map((s) => this.sessionManager.toSharedSessionInfo(s));
  }

  /**
   * Get session manager statistics
   */
  getStats(): {
    sessionCount: number;
    clientCount: number;
    orphanedCount: number;
  } {
    return this.sessionManager.getStats();
  }

  /**
   * Close all sessions and stop server
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Cleanup session manager
    this.sessionManager.cleanup();

    // Close every established connection. WebSocketServer.close() only stops
    // accepting new clients; it intentionally waits for existing clients.
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1001, 'Terminal server shutting down');
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    }
    this.connections.clear();

    // Stop accepting WebSocket upgrades.
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.log('Terminal server closed');
  }
}

/**
 * Express middleware to attach terminal server
 */
export function createTerminalMiddleware(options: TerminalServerOptions = {}): {
  server: TerminalServer;
  attach: (httpServer: HttpServer) => void;
} {
  const server = new TerminalServer(options);
  return {
    server,
    attach: (httpServer: HttpServer) => server.attach(httpServer),
  };
}
