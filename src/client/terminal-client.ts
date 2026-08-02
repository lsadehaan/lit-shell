/**
 * Browser WebSocket client for lit-shell.js.
 */

import type {
  ClientConfig,
  ContainerInfo,
  JoinSessionOptions,
  MessageType,
  ServerInfo,
  SessionInfo,
  SessionListFilter,
  SharedSessionInfo,
  TerminalMessage,
  TerminalOptions,
} from '../shared/types.js';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

type Handler<Arguments extends unknown[]> = (...arguments_: Arguments) => void;

interface PendingRequest<Result = unknown> {
  expectedType: MessageType;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
  transform: (message: TerminalMessage) => Result;
}

interface WireSharedSessionInfo extends Omit<SharedSessionInfo, 'createdAt'> {
  createdAt: string | Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSharedSession(
  session: WireSharedSessionInfo,
): SharedSessionInfo {
  const createdAt =
    session.createdAt instanceof Date
      ? session.createdAt
      : new Date(session.createdAt);

  if (Number.isNaN(createdAt.getTime())) {
    throw new Error(
      `Invalid session creation date: ${String(session.createdAt)}`,
    );
  }

  return { ...session, createdAt };
}

function copyProtocols(
  protocols: ClientConfig['protocols'],
): Required<ClientConfig>['protocols'] {
  return Array.isArray(protocols) ? [...protocols] : (protocols ?? []);
}

/**
 * A stateful client that owns at most one active terminal session.
 *
 * Request/response operations are correlated by `requestId`, so concurrent
 * session-list requests and out-of-order responses remain independent.
 */
export class TerminalClient {
  private readonly config: Required<ClientConfig>;
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private connectPromise: Promise<void> | null = null;
  private sessionId: string | null = null;
  private sessionInfo: SessionInfo | null = null;
  private serverInfo: ServerInfo | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private previousSessionId: string | null = null;
  private resumeToken: string | null = null;
  private previousResumeToken: string | null = null;
  private isReconnecting = false;
  private manualDisconnect = false;
  private requestSequence = 0;

  private readonly pendingRequests = new Map<string, PendingRequest>();

  private readonly connectHandlers: Handler<[]>[] = [];
  private readonly disconnectHandlers: Handler<[]>[] = [];
  private readonly dataHandlers: Handler<[string]>[] = [];
  private readonly exitHandlers: Handler<[number]>[] = [];
  private readonly errorHandlers: Handler<[Error]>[] = [];
  private readonly spawnedHandlers: Handler<[SessionInfo]>[] = [];
  private readonly serverInfoHandlers: Handler<[ServerInfo]>[] = [];
  private readonly containerListHandlers: Handler<[ContainerInfo[]]>[] = [];
  private readonly sessionListHandlers: Handler<[SharedSessionInfo[]]>[] = [];
  private readonly joinedHandlers: Handler<[SharedSessionInfo, string?]>[] = [];
  private readonly leftHandlers: Handler<[string]>[] = [];
  private readonly clientJoinedHandlers: Handler<[string, number]>[] = [];
  private readonly clientLeftHandlers: Handler<[string, number]>[] = [];
  private readonly sessionClosedHandlers: Handler<[string, string]>[] = [];
  private readonly reconnectWithSessionHandlers: Handler<[string]>[] = [];

  constructor(config: ClientConfig) {
    this.config = {
      url: config.url,
      protocols: copyProtocols(config.protocols),
      reconnect: config.reconnect ?? true,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
      reconnectDelay: config.reconnectDelay ?? 1_000,
    };
  }

  /** Connect to the configured terminal server. */
  connect(): Promise<void> {
    if (this.state === 'connected') return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.manualDisconnect = false;
    this.state = 'connecting';

    let resolveConnection!: () => void;
    let rejectConnection!: (error: Error) => void;
    const connection = new Promise<void>((resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
    });
    this.connectPromise = connection;

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.config.url, this.config.protocols);
      this.ws = socket;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.state = 'disconnected';
      this.connectPromise = null;
      rejectConnection(error);
      return connection;
    }

    socket.onopen = () => {
      if (this.ws !== socket) return;

      this.state = 'connected';
      this.connectPromise = null;
      this.reconnectAttempts = 0;
      resolveConnection();
      this.emit(this.connectHandlers);

      if (this.isReconnecting && this.previousSessionId) {
        void this.checkPreviousSessionAndNotify();
      }
      this.isReconnecting = false;
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;

      const previousState = this.state;
      const shouldReconnect =
        !this.manualDisconnect &&
        this.config.reconnect &&
        this.reconnectAttempts < this.config.maxReconnectAttempts;

      this.ws = null;
      this.state = 'disconnected';
      this.connectPromise = null;

      if (this.sessionId) {
        this.previousSessionId = this.sessionId;
        this.previousResumeToken = this.resumeToken;
      }
      this.clearActiveSession();

      const closeError = new Error('WebSocket connection closed');
      this.rejectPendingRequests(closeError);

      if (previousState === 'connecting') rejectConnection(closeError);
      if (previousState !== 'disconnected') this.emit(this.disconnectHandlers);

      if (shouldReconnect) {
        this.isReconnecting = true;
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      const error = new Error('WebSocket error');
      this.emit(this.errorHandlers, error);
      if (this.ws === socket && this.state === 'connecting') {
        this.state = 'disconnected';
        this.connectPromise = null;
        rejectConnection(error);
      }
    };

    socket.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    return connection;
  }

  /** Disconnect without changing the configured reconnect policy. */
  disconnect(): void {
    this.manualDisconnect = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      return;
    }

    if (this.state !== 'disconnected') {
      this.state = 'disconnected';
      this.rejectPendingRequests(new Error('Client disconnected'));
      this.emit(this.disconnectHandlers);
    }
  }

  /** Forget configured subprotocols after a one-use capability is consumed. */
  clearProtocols(): void {
    this.config.protocols = [];
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    const delay = Math.min(
      this.config.reconnectDelay * 2 ** this.reconnectAttempts,
      30_000,
    );

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.reconnectAttempts += 1;
      void this.connect().catch(() => {
        // `onclose` owns retry scheduling; error handlers receive the cause.
      });
    }, delay);
  }

  private nextRequestId(): string {
    this.requestSequence += 1;
    return `request-${Date.now()}-${this.requestSequence}`;
  }

  private request<Result>(
    message: Record<string, unknown>,
    expectedType: MessageType,
    transform: (response: TerminalMessage) => Result,
  ): Promise<Result> {
    if (this.state !== 'connected' || !this.ws) {
      return Promise.reject(new Error('Not connected to server'));
    }

    const requestId = this.nextRequestId();
    return new Promise<Result>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        expectedType,
        resolve: resolve as (result: unknown) => void,
        reject,
        transform: transform,
      });

      try {
        this.ws?.send(JSON.stringify({ ...message, requestId }));
      } catch (cause) {
        this.pendingRequests.delete(requestId);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  private resolvePending(message: TerminalMessage): void {
    const requestId = message.requestId;
    let pendingId = requestId;
    let pending = requestId ? this.pendingRequests.get(requestId) : undefined;

    // Compatibility for servers that predate request correlation. Only the
    // oldest matching request is settled, preserving deterministic behavior.
    if (!pending && !requestId) {
      for (const [candidateId, candidate] of this.pendingRequests) {
        if (
          message.type === 'error' ||
          candidate.expectedType === message.type
        ) {
          pendingId = candidateId;
          pending = candidate;
          break;
        }
      }
    }

    if (!pending || !pendingId) return;
    if (message.type !== 'error' && pending.expectedType !== message.type)
      return;

    this.pendingRequests.delete(pendingId);
    if (message.type === 'error') {
      pending.reject(new Error(message.error));
      return;
    }

    try {
      pending.resolve(pending.transform(message));
    } catch (cause) {
      pending.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }

  private rejectPendingRequests(error: Error): void {
    const pending = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const request of pending) request.reject(error);
  }

  private handleMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      this.emit(this.errorHandlers, new Error('Server sent invalid JSON'));
      return;
    }

    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      this.emit(
        this.errorHandlers,
        new Error('Server sent an invalid message'),
      );
      return;
    }

    const message = parsed as unknown as TerminalMessage;

    switch (message.type) {
      case 'spawned': {
        const info: SessionInfo = {
          sessionId: message.sessionId,
          shell: message.shell,
          cwd: message.cwd,
          cols: message.cols,
          rows: message.rows,
          createdAt: new Date(),
          container: message.container,
        };
        this.sessionId = info.sessionId;
        this.sessionInfo = info;
        this.resumeToken = message.resumeToken ?? null;
        this.previousSessionId = null;
        this.previousResumeToken = null;
        this.resolvePending(message);
        this.emit(this.spawnedHandlers, info);
        break;
      }

      case 'data':
        if (this.sessionId === message.sessionId) {
          this.emit(this.dataHandlers, message.data);
        }
        break;

      case 'exit':
        if (this.sessionId === message.sessionId) {
          this.emit(this.exitHandlers, message.exitCode);
          this.clearActiveSession();
        }
        break;

      case 'error':
        this.resolvePending(message);
        this.emit(this.errorHandlers, new Error(message.error));
        break;

      case 'serverInfo':
        this.serverInfo = message.info;
        this.emit(this.serverInfoHandlers, message.info);
        break;

      case 'containerList':
        this.emit(this.containerListHandlers, message.containers);
        break;

      case 'sessionList': {
        const sessions = (
          message.sessions as unknown as WireSharedSessionInfo[]
        ).map(normalizeSharedSession);
        const normalized = { ...message, sessions };
        this.resolvePending(normalized);
        this.emit(this.sessionListHandlers, sessions);
        break;
      }

      case 'joined': {
        const session = normalizeSharedSession(message.session);
        const normalized = { ...message, session };
        this.sessionId = session.sessionId;
        this.sessionInfo = session;
        this.resumeToken = message.resumeToken ?? null;
        this.resolvePending(normalized);
        this.emit(this.joinedHandlers, session, message.history);
        break;
      }

      case 'left':
        if (this.sessionId === message.sessionId) {
          this.clearActiveSession();
        }
        this.emit(this.leftHandlers, message.sessionId);
        break;

      case 'clientJoined':
        this.emit(
          this.clientJoinedHandlers,
          message.sessionId,
          message.clientCount,
        );
        break;

      case 'clientLeft':
        this.emit(
          this.clientLeftHandlers,
          message.sessionId,
          message.clientCount,
        );
        break;

      case 'sessionClosed':
        if (this.sessionId === message.sessionId) {
          this.clearActiveSession();
        }
        this.emit(
          this.sessionClosedHandlers,
          message.sessionId,
          message.reason,
        );
        break;

      default:
        this.emit(
          this.errorHandlers,
          new Error(
            `Server sent an unknown message type: ${String(parsed.type)}`,
          ),
        );
    }
  }

  /** Spawn a new terminal session. */
  spawn(options: TerminalOptions = {}): Promise<SessionInfo> {
    if (this.sessionId) {
      return Promise.reject(
        new Error('Session already active. Call kill() or leave() first.'),
      );
    }

    const secureOptions = { allowJoin: false, ...options };
    return this.request(
      { type: 'spawn', options: secureOptions },
      'spawned',
      (message) => {
        if (message.type !== 'spawned')
          throw new Error('Invalid spawn response');
        return {
          sessionId: message.sessionId,
          shell: message.shell,
          cwd: message.cwd,
          cols: message.cols,
          rows: message.rows,
          createdAt: new Date(),
          container: message.container,
        };
      },
    );
  }

  /** Write text to the active terminal. */
  write(data: string): void {
    this.sendForActiveSession({ type: 'data', data });
  }

  /** Resize the active terminal. */
  resize(cols: number, rows: number): void {
    this.sendForActiveSession({ type: 'resize', cols, rows });
  }

  /** Terminate the active terminal. */
  kill(): void {
    if (!this.sessionId) return;
    this.sendForActiveSession({ type: 'close' });
  }

  private sendForActiveSession(message: Record<string, unknown>): void {
    if (!this.ws || this.state !== 'connected') {
      this.emit(this.errorHandlers, new Error('Not connected to server'));
      return;
    }
    if (!this.sessionId) {
      this.emit(this.errorHandlers, new Error('No active session'));
      return;
    }
    this.ws.send(JSON.stringify({ ...message, sessionId: this.sessionId }));
  }

  /** List sessions available to join. */
  listSessions(filter?: SessionListFilter): Promise<SharedSessionInfo[]> {
    return this.request(
      { type: 'listSessions', filter },
      'sessionList',
      (message) => {
        if (message.type !== 'sessionList') {
          throw new Error('Invalid session-list response');
        }
        return message.sessions;
      },
    );
  }

  /** Join an existing session. */
  join(options: JoinSessionOptions): Promise<SharedSessionInfo> {
    if (this.sessionId) {
      return Promise.reject(
        new Error('Already in a session. Call leave() first.'),
      );
    }

    const resumeToken =
      options.resumeToken ??
      (options.sessionId === this.previousSessionId
        ? this.previousResumeToken
        : null);
    const joinOptions = resumeToken ? { ...options, resumeToken } : options;
    return this.request(
      { type: 'join', options: joinOptions },
      'joined',
      (message) => {
        if (message.type !== 'joined') throw new Error('Invalid join response');
        return message.session;
      },
    );
  }

  /** Leave a session without terminating its PTY. */
  leave(sessionId = this.sessionId ?? undefined): void {
    if (!sessionId) {
      this.emit(this.errorHandlers, new Error('No active session'));
      return;
    }
    if (!this.ws || this.state !== 'connected') {
      this.emit(this.errorHandlers, new Error('Not connected to server'));
      return;
    }
    this.ws.send(JSON.stringify({ type: 'leave', sessionId }));
  }

  /** Request a list while notifying `onSessionList` subscribers. */
  requestSessionList(filter?: SessionListFilter): void {
    void this.listSessions(filter).catch((error: unknown) => {
      this.emit(
        this.errorHandlers,
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  }

  onConnect(handler: Handler<[]>): void {
    this.connectHandlers.push(handler);
  }

  onDisconnect(handler: Handler<[]>): void {
    this.disconnectHandlers.push(handler);
  }

  onData(handler: Handler<[string]>): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: Handler<[number]>): void {
    this.exitHandlers.push(handler);
  }

  onError(handler: Handler<[Error]>): void {
    this.errorHandlers.push(handler);
  }

  onSpawned(handler: Handler<[SessionInfo]>): void {
    this.spawnedHandlers.push(handler);
  }

  onServerInfo(handler: Handler<[ServerInfo]>): void {
    this.serverInfoHandlers.push(handler);
    if (this.serverInfo) this.emit([handler], this.serverInfo);
  }

  onContainerList(handler: Handler<[ContainerInfo[]]>): void {
    this.containerListHandlers.push(handler);
  }

  onSessionList(handler: Handler<[SharedSessionInfo[]]>): void {
    this.sessionListHandlers.push(handler);
  }

  onJoined(handler: Handler<[SharedSessionInfo, string?]>): void {
    this.joinedHandlers.push(handler);
  }

  onLeft(handler: Handler<[string]>): void {
    this.leftHandlers.push(handler);
  }

  onClientJoined(handler: Handler<[string, number]>): void {
    this.clientJoinedHandlers.push(handler);
  }

  onClientLeft(handler: Handler<[string, number]>): void {
    this.clientLeftHandlers.push(handler);
  }

  onSessionClosed(handler: Handler<[string, string]>): void {
    this.sessionClosedHandlers.push(handler);
  }

  requestContainerList(): void {
    if (!this.ws || this.state !== 'connected') {
      this.emit(this.errorHandlers, new Error('Not connected to server'));
      return;
    }
    this.ws.send(JSON.stringify({ type: 'listContainers' }));
  }

  getState(): ConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getSessionInfo(): SessionInfo | null {
    return this.sessionInfo;
  }

  hasActiveSession(): boolean {
    return this.sessionId !== null;
  }

  getServerInfo(): ServerInfo | null {
    return this.serverInfo;
  }

  getPreviousSessionId(): string | null {
    return this.previousSessionId;
  }

  clearPreviousSessionId(): void {
    this.previousSessionId = null;
    this.previousResumeToken = null;
  }

  private clearActiveSession(): void {
    this.sessionId = null;
    this.sessionInfo = null;
    this.resumeToken = null;
  }

  onReconnectWithSession(handler: Handler<[string]>): void {
    this.reconnectWithSessionHandlers.push(handler);
  }

  private async checkPreviousSessionAndNotify(): Promise<void> {
    const previousSessionId = this.previousSessionId;
    if (!previousSessionId) return;

    try {
      if (this.previousResumeToken) {
        this.emit(this.reconnectWithSessionHandlers, previousSessionId);
        return;
      }
      const sessions = await this.listSessions();
      const previous = sessions.find(
        (session) => session.sessionId === previousSessionId,
      );
      if (previous?.accepting) {
        this.emit(this.reconnectWithSessionHandlers, previousSessionId);
      } else {
        this.previousSessionId = null;
      }
    } catch (cause) {
      this.previousSessionId = null;
      this.emit(
        this.errorHandlers,
        cause instanceof Error ? cause : new Error(String(cause)),
      );
    }
  }

  private emit<Arguments extends unknown[]>(
    handlers: readonly Handler<Arguments>[],
    ...arguments_: Arguments
  ): void {
    for (const handler of [...handlers]) {
      try {
        handler(...arguments_);
      } catch (cause) {
        // Consumer callbacks must never interrupt protocol state transitions or
        // strand promises. Errors remain visible without being re-thrown.
        console.error('[lit-shell] Event handler failed:', cause);
      }
    }
  }
}
