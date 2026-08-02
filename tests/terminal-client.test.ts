import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalClient } from '../src/client/terminal-client.js';

type Listener = ((event?: any) => void) | null;

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: TestWebSocket[] = [];

  readonly url: string;
  readyState = TestWebSocket.CONNECTING;
  sent: Record<string, unknown>[] = [];
  onopen: Listener = null;
  onclose: Listener = null;
  onerror: Listener = null;
  onmessage: Listener = null;

  constructor(url: string) {
    this.url = url;
    TestWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== TestWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    if (this.readyState >= TestWebSocket.CLOSING) return;
    this.readyState = TestWebSocket.CLOSING;
    queueMicrotask(() => this.finishClose());
  }

  open(): void {
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.({ type: 'open' });
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  finishClose(): void {
    if (this.readyState === TestWebSocket.CLOSED) return;
    this.readyState = TestWebSocket.CLOSED;
    this.onclose?.({ type: 'close' });
  }
}

function latestSocket(): TestWebSocket {
  const socket = TestWebSocket.instances.at(-1);
  if (!socket) throw new Error('Expected a WebSocket instance');
  return socket;
}

async function connectedClient(
  config: ConstructorParameters<typeof TerminalClient>[0] = {
    url: 'ws://terminal.test',
    reconnect: false,
  },
): Promise<{ client: TerminalClient; socket: TestWebSocket }> {
  const client = new TerminalClient(config);
  const connecting = client.connect();
  const socket = latestSocket();
  socket.open();
  await connecting;
  return { client, socket };
}

async function spawnSession(
  client: TerminalClient,
  socket: TestWebSocket,
  options: Parameters<TerminalClient['spawn']>[0] = {},
  resumeToken?: string,
): Promise<void> {
  const spawning = client.spawn(options);
  const request = socket.sent.at(-1)!;
  socket.receive({
    type: 'spawned',
    requestId: request.requestId,
    sessionId: 'session-1',
    shell: '/bin/sh',
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    resumeToken,
  });
  await spawning;
}

async function reconnectAfterClose(
  socket: TestWebSocket,
): Promise<TestWebSocket> {
  socket.finishClose();
  await vi.advanceTimersByTimeAsync(1);
  const replacement = latestSocket();
  replacement.open();
  await Promise.resolve();
  return replacement;
}

describe('TerminalClient public contract', () => {
  beforeEach(() => {
    TestWebSocket.instances = [];
    vi.stubGlobal('WebSocket', TestWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('deduplicates concurrent connection attempts', async () => {
    const client = new TerminalClient({
      url: 'ws://terminal.test',
      reconnect: false,
    });

    const first = client.connect();
    const second = client.connect();

    expect(TestWebSocket.instances).toHaveLength(1);
    latestSocket().open();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it('correlates concurrent requests even when responses arrive out of order', async () => {
    const { client, socket } = await connectedClient();

    const local = client.listSessions({ type: 'local' });
    const docker = client.listSessions({ type: 'docker-exec' });
    const localRequest = socket.sent.at(-2)!;
    const dockerRequest = socket.sent.at(-1)!;

    expect(localRequest.requestId).toEqual(expect.any(String));
    expect(dockerRequest.requestId).toEqual(expect.any(String));
    expect(localRequest.requestId).not.toBe(dockerRequest.requestId);

    socket.receive({
      type: 'sessionList',
      requestId: dockerRequest.requestId,
      sessions: [
        {
          sessionId: 'docker-1',
          type: 'docker-exec',
          shell: '/bin/sh',
          cwd: '/',
          cols: 80,
          rows: 24,
          createdAt: '2026-01-01T00:00:00.000Z',
          clientCount: 1,
          accepting: true,
          historyEnabled: true,
        },
      ],
    });
    socket.receive({
      type: 'sessionList',
      requestId: localRequest.requestId,
      sessions: [
        {
          sessionId: 'local-1',
          type: 'local',
          shell: '/bin/sh',
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          createdAt: '2026-01-01T00:00:00.000Z',
          clientCount: 1,
          accepting: true,
          historyEnabled: true,
        },
      ],
    });

    await expect(local).resolves.toMatchObject([{ sessionId: 'local-1' }]);
    await expect(docker).resolves.toMatchObject([{ sessionId: 'docker-1' }]);
  });

  it('rejects pending operations when the connection closes', async () => {
    const { client, socket } = await connectedClient();
    const spawning = client.spawn({ shell: '/bin/sh' });

    socket.finishClose();

    await expect(spawning).rejects.toThrow(/connection.*closed|disconnected/i);
  });

  it('makes spawn private by default and retains explicit sharing', async () => {
    const { client, socket } = await connectedClient();
    const privateSpawn = client.spawn({ shell: '/bin/sh' });
    const privateRequest = socket.sent.at(-1)!;
    expect(privateRequest).toMatchObject({
      type: 'spawn',
      options: { shell: '/bin/sh', allowJoin: false },
    });
    socket.receive({
      type: 'spawned',
      requestId: privateRequest.requestId,
      sessionId: 'private-1',
      shell: '/bin/sh',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      resumeToken: 'owner-token',
    });
    await privateSpawn;
    client.kill();
    socket.receive({
      type: 'sessionClosed',
      sessionId: 'private-1',
      reason: 'owner_closed',
    });

    const sharedSpawn = client.spawn({ allowJoin: true });
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'spawn',
      options: { allowJoin: true },
    });
    socket.finishClose();
    await expect(sharedSpawn).rejects.toThrow();
  });

  it('resumes a private session with its owner token after reconnecting', async () => {
    vi.useFakeTimers();
    const { client, socket } = await connectedClient({
      url: 'ws://terminal.test',
      reconnect: true,
      reconnectDelay: 1,
      maxReconnectAttempts: 1,
    });
    const recoverable = vi.fn();
    client.onReconnectWithSession(recoverable);
    await spawnSession(client, socket, {}, 'owner-token');

    const replacement = await reconnectAfterClose(socket);

    expect(recoverable).toHaveBeenCalledWith('session-1');
    expect(replacement.sent).toEqual([]);

    const joining = client.join({
      sessionId: 'session-1',
      requestHistory: true,
    });
    const request = replacement.sent.at(-1)!;
    expect(request).toMatchObject({
      type: 'join',
      options: {
        sessionId: 'session-1',
        requestHistory: true,
        resumeToken: 'owner-token',
      },
    });
    replacement.receive({
      type: 'joined',
      requestId: request.requestId,
      session: {
        sessionId: 'session-1',
        type: 'local',
        shell: '/bin/sh',
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        createdAt: '2026-01-02T03:04:05.000Z',
        clientCount: 1,
        accepting: false,
        historyEnabled: true,
      },
      resumeToken: 'rotated-owner-token',
    });

    await expect(joining).resolves.toMatchObject({ sessionId: 'session-1' });
    await expect(client.join({ sessionId: 'another-session' })).rejects.toThrow(
      /already in a session/i,
    );
  });

  it('checks that a tokenless previous session still accepts participants', async () => {
    vi.useFakeTimers();
    const { client, socket } = await connectedClient({
      url: 'ws://terminal.test',
      reconnect: true,
      reconnectDelay: 1,
      maxReconnectAttempts: 1,
    });
    const recoverable = vi.fn();
    client.onReconnectWithSession(recoverable);
    await spawnSession(client, socket, { allowJoin: true });

    const replacement = await reconnectAfterClose(socket);
    const request = replacement.sent.at(-1)!;
    expect(request).toMatchObject({ type: 'listSessions' });
    replacement.receive({
      type: 'sessionList',
      requestId: request.requestId,
      sessions: [
        {
          sessionId: 'session-1',
          type: 'local',
          shell: '/bin/sh',
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          createdAt: '2026-01-02T03:04:05.000Z',
          clientCount: 1,
          accepting: true,
          historyEnabled: true,
        },
      ],
    });
    await Promise.resolve();

    expect(recoverable).toHaveBeenCalledWith('session-1');
    expect(client.getPreviousSessionId()).toBe('session-1');
  });

  it('forgets a tokenless previous session when it is no longer joinable', async () => {
    vi.useFakeTimers();
    const { client, socket } = await connectedClient({
      url: 'ws://terminal.test',
      reconnect: true,
      reconnectDelay: 1,
      maxReconnectAttempts: 1,
    });
    const recoverable = vi.fn();
    client.onReconnectWithSession(recoverable);
    await spawnSession(client, socket, { allowJoin: true });

    const replacement = await reconnectAfterClose(socket);
    const request = replacement.sent.at(-1)!;
    replacement.receive({
      type: 'sessionList',
      requestId: request.requestId,
      sessions: [],
    });
    await Promise.resolve();

    expect(recoverable).not.toHaveBeenCalled();
    expect(client.getPreviousSessionId()).toBeNull();
  });

  it('notifies session-list subscribers once per server message', async () => {
    const { client, socket } = await connectedClient();
    const handler = vi.fn();
    client.onSessionList(handler);

    client.requestSessionList();
    const request = socket.sent.at(-1)!;
    socket.receive({
      type: 'sessionList',
      requestId: request.requestId,
      sessions: [],
    });
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('exposes createdAt as the Date promised by the public type', async () => {
    const { client, socket } = await connectedClient();
    const listing = client.listSessions();
    const request = socket.sent.at(-1)!;

    socket.receive({
      type: 'sessionList',
      requestId: request.requestId,
      sessions: [
        {
          sessionId: 'session-1',
          type: 'local',
          shell: '/bin/sh',
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          createdAt: '2026-01-02T03:04:05.000Z',
          clientCount: 1,
          accepting: true,
          historyEnabled: true,
        },
      ],
    });

    const session = (await listing)[0]!;
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.createdAt.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  it('settles internal promises even when a consumer callback throws', async () => {
    const { client, socket } = await connectedClient();
    client.onSpawned(() => {
      throw new Error('consumer callback failed');
    });

    const spawning = client.spawn({ shell: '/bin/sh' });
    const request = socket.sent.at(-1)!;
    socket.receive({
      type: 'spawned',
      requestId: request.requestId,
      sessionId: 'session-1',
      shell: '/bin/sh',
      cwd: '/tmp',
      cols: 80,
      rows: 24,
    });

    await expect(spawning).resolves.toMatchObject({ sessionId: 'session-1' });
  });

  it('emits disconnect for an explicit disconnect without disabling future reconnect policy', async () => {
    const { client } = await connectedClient({
      url: 'ws://terminal.test',
      reconnect: true,
      reconnectDelay: 1,
      maxReconnectAttempts: 1,
    });
    const handler = vi.fn();
    client.onDisconnect(handler);

    client.disconnect();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);

    const reconnecting = client.connect();
    latestSocket().open();
    await reconnecting;
    latestSocket().finishClose();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(TestWebSocket.instances).toHaveLength(3);
  });
});
