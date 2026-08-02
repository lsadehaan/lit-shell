import { createServer, type Server as HttpServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { WebSocket } from 'ws';

// Import only through the public server barrel. These tests deliberately avoid
// implementation modules so they exercise the same API exposed to consumers.
import {
  TerminalServer,
  type TerminalServerOptions,
} from '../../src/server/index.js';

export interface WireMessage {
  type?: string;
  [key: string]: unknown;
}

export interface StartedTestServer {
  readonly terminal: TerminalServer;
  readonly http: HttpServer;
  readonly url: string;
  connect(onOpen?: (client: ProtocolClient) => void): Promise<ProtocolClient>;
  dispose(): Promise<void>;
}

const DEFAULT_TIMEOUT = 2_000;

export class ProtocolClient {
  readonly socket: WebSocket;
  readonly messages: WireMessage[] = [];

  private readonly changeListeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private opened = false;
  private closed = false;

  constructor(url: string) {
    this.socket = new WebSocket(url);

    this.socket.on('open', () => {
      this.opened = true;
      this.notifyChange();
    });

    this.socket.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString()) as unknown;
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed)
        ) {
          this.messages.push(parsed as WireMessage);
        } else {
          this.messages.push({
            type: '__invalid_server_message__',
            value: parsed,
          });
        }
      } catch {
        this.messages.push({
          type: '__invalid_server_json__',
          value: data.toString(),
        });
      }
      this.notifyChange();
    });

    this.socket.on('close', () => {
      this.closed = true;
      this.notifyChange();
      for (const listener of [...this.closeListeners]) listener();
    });

    // WebSocket emits error before close for connection failures. Keeping an
    // error listener prevents an expected rejection from becoming uncaught.
    this.socket.on('error', () => this.notifyChange());
  }

  async open(
    onOpen?: (client: ProtocolClient) => void,
    timeout = DEFAULT_TIMEOUT,
  ): Promise<void> {
    if (this.opened) {
      onOpen?.(this);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`WebSocket did not open within ${timeout}ms`));
      }, timeout);

      const handleOpen = () => {
        cleanup();
        onOpen?.(this);
        resolve();
      };
      const handleClose = () => {
        cleanup();
        reject(new Error('WebSocket closed before opening'));
      };
      const handleError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off('open', handleOpen);
        this.socket.off('close', handleClose);
        this.socket.off('error', handleError);
      };

      this.socket.once('open', handleOpen);
      this.socket.once('close', handleClose);
      this.socket.once('error', handleError);
    });
  }

  mark(): number {
    return this.messages.length;
  }

  send(message: Record<string, unknown>): void {
    this.sendRaw(JSON.stringify(message));
  }

  sendRaw(payload: string | Buffer): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Cannot send on a WebSocket that is not open');
    }
    this.socket.send(payload);
  }

  async waitFor(
    predicate: (message: WireMessage) => boolean,
    options: { from?: number; timeout?: number; description?: string } = {},
  ): Promise<WireMessage> {
    const from = options.from ?? 0;
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const description = options.description ?? 'matching protocol message';

    const find = () => this.messages.slice(from).find(predicate);
    const existing = find();
    if (existing) return existing;

    return new Promise<WireMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out after ${timeout}ms waiting for ${description}. ` +
              `Messages: ${JSON.stringify(this.messages.slice(from))}`,
          ),
        );
      }, timeout);

      const scan = () => {
        const found = find();
        if (found) {
          cleanup();
          resolve(found);
        } else if (this.closed) {
          cleanup();
          reject(
            new Error(
              `WebSocket closed while waiting for ${description}. ` +
                `Messages: ${JSON.stringify(this.messages.slice(from))}`,
            ),
          );
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.changeListeners.delete(scan);
      };

      this.changeListeners.add(scan);
      scan();
    });
  }

  waitForType(
    type: string,
    options: { from?: number; timeout?: number } = {},
  ): Promise<WireMessage> {
    return this.waitFor((message) => message.type === type, {
      ...options,
      description: `a ${type} message`,
    });
  }

  async waitForOutput(
    expected: string | RegExp,
    options: { sessionId?: string; from?: number; timeout?: number } = {},
  ): Promise<string> {
    const from = options.from ?? 0;
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const description = `terminal output matching ${String(expected)}`;

    const output = () =>
      this.messages
        .slice(from)
        .filter(
          (message) =>
            message.type === 'data' &&
            typeof message.data === 'string' &&
            (!options.sessionId || message.sessionId === options.sessionId),
        )
        .map((message) => message.data as string)
        .join('');
    const matches = (value: string) =>
      typeof expected === 'string'
        ? value.includes(expected)
        : expected.test(value);

    const existing = output();
    if (matches(existing)) return existing;

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out after ${timeout}ms waiting for ${description}. ` +
              `Output: ${JSON.stringify(output())}`,
          ),
        );
      }, timeout);

      const scan = () => {
        const value = output();
        if (matches(value)) {
          cleanup();
          resolve(value);
        } else if (this.closed) {
          cleanup();
          reject(
            new Error(
              `WebSocket closed while waiting for ${description}. ` +
                `Output: ${JSON.stringify(value)}`,
            ),
          );
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.changeListeners.delete(scan);
      };

      this.changeListeners.add(scan);
      scan();
    });
  }

  async expectNoOutput(
    unexpected: string,
    options: { sessionId?: string; from?: number; duration?: number } = {},
  ): Promise<void> {
    const duration = options.duration ?? 300;
    try {
      const output = await this.waitForOutput(unexpected, {
        ...options,
        timeout: duration,
      });
      throw new Error(
        `Unexpected terminal output ${JSON.stringify(unexpected)} was received: ` +
          JSON.stringify(output),
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Timed out after'))
        return;
      throw error;
    }
  }

  async waitForClose(timeout = DEFAULT_TIMEOUT): Promise<void> {
    if (this.closed) return;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`WebSocket did not close within ${timeout}ms`));
      }, timeout);
      const handleClose = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.closeListeners.delete(handleClose);
      };

      this.closeListeners.add(handleClose);
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    if (this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.terminate();
      return;
    }

    this.socket.close(1000, 'test cleanup');
    try {
      await this.waitForClose(500);
    } catch {
      this.socket.terminate();
      await this.waitForClose(500).catch(() => undefined);
    }
  }

  terminate(): void {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }

  private notifyChange(): void {
    for (const listener of [...this.changeListeners]) listener();
  }
}

export async function startTestServer(
  options: TerminalServerOptions = {},
): Promise<StartedTestServer> {
  const clients = new Set<ProtocolClient>();
  const http = createServer((_request, response) => {
    response.statusCode = 404;
    response.end('not found');
  });
  const terminal = new TerminalServer({
    path: '/terminal',
    allowedShells: ['/bin/sh'],
    defaultShell: '/bin/sh',
    allowedPaths: [process.cwd()],
    defaultCwd: process.cwd(),
    idleTimeout: 0,
    orphanTimeout: 500,
    historyEnabled: true,
    historySize: 16_384,
    verbose: false,
    ...options,
  });

  terminal.attach(http);
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });

  const address = http.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test HTTP server did not expose a TCP address');
  }
  const path = options.path ?? '/terminal';
  const url = `ws://127.0.0.1:${address.port}${path}`;

  return {
    terminal,
    http,
    url,
    async connect(onOpen) {
      const client = new ProtocolClient(url);
      clients.add(client);
      await client.open(onOpen);
      return client;
    },
    async dispose() {
      for (const client of clients) client.terminate();
      terminal.close();

      http.closeAllConnections?.();
      if (http.listening) {
        await Promise.race([
          new Promise<void>((resolve) => http.close(() => resolve())),
          delay(750).then(() => undefined),
        ]);
      }
    },
  };
}

export function testEnvironment(
  additions: Record<string, string> = {},
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    TERM: 'xterm-256color',
    PS1: '',
    ...additions,
  };
}

/** Build a POSIX-shell command whose echoed input does not contain the output. */
export function printCommand(value: string): string {
  const escaped = [...Buffer.from(value)]
    .map((byte) => `\\${byte.toString(8).padStart(3, '0')}`)
    .join('');
  return `printf '%b\\n' '${escaped}'\n`;
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number; description?: string } = {},
): Promise<void> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const interval = options.interval ?? 20;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(interval);
  }

  throw new Error(
    `Timed out after ${timeout}ms waiting for ${options.description ?? 'condition'}`,
  );
}

export async function expectConnectionRejected(
  url: string,
  timeout = DEFAULT_TIMEOUT,
): Promise<void> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(
        new Error(`WebSocket connection was not rejected within ${timeout}ms`),
      );
    }, timeout);
    const accepted = () => {
      cleanup();
      socket.terminate();
      reject(new Error('WebSocket connection unexpectedly succeeded'));
    };
    const rejected = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('open', accepted);
      socket.off('error', rejected);
      socket.off('close', rejected);
      socket.off('unexpected-response', rejected);
    };

    socket.once('open', accepted);
    socket.once('error', rejected);
    socket.once('close', rejected);
    socket.once('unexpected-response', rejected);
  });
}
