import { createServer, type Server as HttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';

export interface BrowserFixture {
  readonly origin: string;
  readonly websocketUrl: string;
  pageUrl(options?: PageOptions): string;
  disconnectBrowsers(): Promise<void>;
  close(): Promise<void>;
}

interface PageOptions {
  autoConnect?: boolean;
  autoSpawn?: boolean;
  showConnectionPanel?: boolean;
  showSettings?: boolean;
  showStatusBar?: boolean;
  showTabs?: boolean;
  theme?: 'dark' | 'light' | 'auto';
}

interface TerminalServerLike {
  attach(server: HttpServer): void;
  close(): void;
}

const repositoryRoot = resolve(process.cwd());
const distributionRoot = resolve(repositoryRoot, 'dist');
// Keep this non-literal so type-checking a clean checkout does not require the
// generated distribution. Browser tests build it before starting the fixture.
const terminalServerModulePath = '../../../dist/server/index.js';

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export async function startBrowserFixture(): Promise<BrowserFixture> {
  const { TerminalServer } = (await import(
    terminalServerModulePath
  )) as unknown as {
    TerminalServer: new (
      options: Record<string, unknown>,
    ) => TerminalServerLike;
  };

  const backend = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const terminalServer = new TerminalServer({
    allowedPaths: [repositoryRoot],
    allowedShells: ['/bin/sh'],
    defaultCwd: repositoryRoot,
    defaultShell: '/bin/sh',
    historyEnabled: true,
    idleTimeout: 0,
    maxClientsPerSession: 10,
    maxSessionsPerClient: 10,
    maxSessionsTotal: 50,
    orphanTimeout: 15_000,
    path: '/terminal',
    verbose: false,
  });
  terminalServer.attach(backend);
  await listen(backend);

  const backendAddress = backend.address();
  if (!backendAddress || typeof backendAddress === 'string') {
    throw new Error('Could not determine the terminal fixture address');
  }
  const backendWebSocketUrl = `ws://127.0.0.1:${backendAddress.port}/terminal`;

  let publicOrigin = '';
  const frontend = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', publicOrigin);
      if (
        requestUrl.pathname === '/' ||
        requestUrl.pathname === '/index.html'
      ) {
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'text/html; charset=utf-8',
        });
        response.end(renderTestPage(requestUrl.searchParams));
        return;
      }

      if (requestUrl.pathname.startsWith('/dist/')) {
        const filePath = resolve(repositoryRoot, `.${requestUrl.pathname}`);
        if (!filePath.startsWith(`${distributionRoot}${sep}`)) {
          response.writeHead(403).end();
          return;
        }
        const file = await readFile(filePath);
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type':
            contentTypes[extname(filePath)] ?? 'application/octet-stream',
        });
        response.end(file);
        return;
      }

      if (requestUrl.pathname === '/favicon.ico') {
        response.writeHead(204).end();
        return;
      }

      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });

  const browserSockets = new Set<WebSocket>();
  const proxy = new WebSocketServer({ server: frontend, path: '/terminal' });
  proxy.on('connection', (browserSocket) => {
    browserSockets.add(browserSocket);
    const backendSocket = new WebSocket(backendWebSocketUrl);
    const queuedMessages: Array<{ data: Buffer; isBinary: boolean }> = [];

    browserSocket.on('message', (data, isBinary) => {
      const message = {
        data: toBuffer(data),
        isBinary,
      };
      if (backendSocket.readyState === WebSocket.OPEN) {
        backendSocket.send(message.data, { binary: message.isBinary });
      } else if (backendSocket.readyState === WebSocket.CONNECTING) {
        queuedMessages.push(message);
      }
    });

    backendSocket.on('open', () => {
      for (const message of queuedMessages.splice(0)) {
        backendSocket.send(message.data, { binary: message.isBinary });
      }
    });

    backendSocket.on('message', (data, isBinary) => {
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.send(data, { binary: isBinary });
      }
    });

    browserSocket.on('close', () => {
      browserSockets.delete(browserSocket);
      if (
        backendSocket.readyState === WebSocket.OPEN ||
        backendSocket.readyState === WebSocket.CONNECTING
      ) {
        backendSocket.close(1000, 'browser disconnected');
      }
    });

    backendSocket.on('close', (code, reason) => {
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.close(normalizeCloseCode(code), reason.toString());
      }
    });

    backendSocket.on('error', () => {
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.close(1011, 'terminal backend unavailable');
      }
    });
  });

  await listen(frontend);
  const frontendAddress = frontend.address();
  if (!frontendAddress || typeof frontendAddress === 'string') {
    throw new Error('Could not determine the browser fixture address');
  }
  publicOrigin = `http://127.0.0.1:${frontendAddress.port}`;
  const websocketUrl = `ws://127.0.0.1:${frontendAddress.port}/terminal`;

  let closed = false;
  return {
    origin: publicOrigin,
    websocketUrl,
    pageUrl(options = {}) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(options)) {
        if (value !== undefined) query.set(key, String(value));
      }
      return `${publicOrigin}/?${query}`;
    },
    async disconnectBrowsers() {
      const sockets = [...browserSockets].filter(
        (socket) => socket.readyState === WebSocket.OPEN,
      );
      await Promise.all(
        sockets.map(
          (socket) =>
            new Promise<void>((resolveClose) => {
              socket.once('close', () => resolveClose());
              // 1001 models a proxy or server going away without making WebKit
              // report the deliberate shutdown as a failed HTTP upgrade.
              socket.close(1001, 'fixture transport restart');
            }),
        ),
      );
    },
    async close() {
      if (closed) return;
      closed = true;

      for (const socket of browserSockets) {
        socket.close(1001, 'fixture shutting down');
      }
      await closeWebSocketServer(proxy);
      terminalServer.close();
      await Promise.all([closeHttpServer(frontend), closeHttpServer(backend)]);
    },
  };
}

function renderTestPage(options: URLSearchParams): string {
  const attributes = [
    ['url', '__WEBSOCKET_URL__'],
    ['shell', '/bin/sh'],
    ['cwd', repositoryRoot],
    ['theme', option(options, 'theme', 'dark')],
    ['auto-connect', booleanOption(options, 'autoConnect')],
    ['auto-spawn', booleanOption(options, 'autoSpawn')],
    ['show-connection-panel', booleanOption(options, 'showConnectionPanel')],
    ['show-settings', booleanOption(options, 'showSettings')],
    ['show-status-bar', booleanOption(options, 'showStatusBar')],
    ['show-tabs', booleanOption(options, 'showTabs')],
  ].filter(([, value]) => value !== null);

  const serializedAttributes = JSON.stringify(attributes);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>lit-shell browser test</title>
    <style>
      html, body { height: 100%; margin: 0; }
      body { min-height: 100%; }
      main { height: 100%; }
      .visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
      lit-shell-terminal { display: block; height: 720px; width: 100%; }
    </style>
  </head>
  <body>
    <main>
      <h1 class="visually-hidden">lit-shell terminal integration test</h1>
    </main>
    <script type="module">
      import '/dist/ui/browser-bundle.js';

      await customElements.whenDefined('lit-shell-terminal');
      const terminal = document.createElement('lit-shell-terminal');
      const attributes = ${serializedAttributes};
      for (const [name, value] of attributes) {
        if (value === true) terminal.setAttribute(name, '');
        else if (value === '__WEBSOCKET_URL__') {
          terminal.setAttribute(name, location.origin.replace(/^http/, 'ws') + '/terminal');
        } else terminal.setAttribute(name, value);
      }

      const events = [];
      for (const type of [
        'connect',
        'disconnect',
        'spawned',
        'exit',
        'error',
        'theme-change',
      ]) {
        terminal.addEventListener(type, (event) => {
          let detail = null;
          if ('detail' in event && event.detail !== undefined) {
            try { detail = JSON.parse(JSON.stringify(event.detail)); }
            catch { detail = String(event.detail); }
          }
          events.push({ type, detail, timestamp: performance.now() });
        });
      }

      document.querySelector('main').append(terminal);
      window.litShellTerminal = terminal;
      window.litShellEvents = events;
      window.litShellReady = true;
    </script>
  </body>
</html>`;
}

function option(
  options: URLSearchParams,
  name: string,
  fallback: string,
): string {
  return options.get(name) ?? fallback;
}

function booleanOption(options: URLSearchParams, name: string): true | null {
  return options.get(name) === 'true' ? true : null;
}

function normalizeCloseCode(code: number): number {
  return code >= 1000 && code <= 4999 ? code : 1011;
}

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  return data;
}

async function listen(server: HttpServer): Promise<void> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  server.close();
  server.closeAllConnections();
  await once(server, 'close');
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
