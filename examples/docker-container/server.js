import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TerminalServer } from 'lit-shell.js/server';

import {
  parseAllowedOrigins,
  parsePort,
  parseRequestPath,
  reportRequestFailure,
  sendFile,
  sendJson,
  sendText,
} from '../shared/http.js';

const exampleDirectory = dirname(fileURLToPath(import.meta.url));
const distDirectory = resolve(exampleDirectory, '../../dist');
const exampleAssets = new Set(['/app.js', '/index.html', '/style.css']);

const host = process.env.HOST ?? '127.0.0.1';
const port = parsePort(process.env.PORT);
const allowedOrigins = parseAllowedOrigins(
  process.env.LIT_SHELL_ALLOWED_ORIGINS,
  port,
);
const verbose = process.env.LIT_SHELL_VERBOSE === 'true';
const terminalServer = new TerminalServer({
  allowedOrigins,
  allowLocalExec: false,
  allowDockerExec: true,
  allowedContainerPatterns: ['^test-[a-z0-9][a-z0-9_.-]*$'],
  defaultContainerShell: '/bin/sh',

  maxClientsPerSession: 3,
  maxSessionsPerClient: 2,
  maxSessionsTotal: 6,
  orphanTimeout: 30_000,
  idleTimeout: 10 * 60_000,
  verbose,
});

async function handleRequest(request, response) {
  const pathname = parseRequestPath(request, response);
  if (pathname === null) return;

  if (pathname === '/healthz') {
    sendJson(request, response, 200, { status: 'ok' });
    return;
  }

  if (pathname === '/') {
    await sendFile(request, response, {
      root: exampleDirectory,
      pathname: '/index.html',
    });
    return;
  }

  if (exampleAssets.has(pathname)) {
    await sendFile(request, response, { root: exampleDirectory, pathname });
    return;
  }

  if (pathname.startsWith('/dist/')) {
    await sendFile(request, response, {
      root: distDirectory,
      pathname: pathname.slice('/dist'.length),
    });
    return;
  }

  sendText(request, response, 404, 'Not found\n');
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    reportRequestFailure(response, error);
  });
});

server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});
terminalServer.attach(server);

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[example] ${signal} received; shutting down`);
  terminalServer.close();
  server.close((error) => {
    process.exitCode = error ? 1 : 0;
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

server.listen(port, host, () => {
  const displayHost = host.includes(':') ? `[${host}]` : host;
  const origin = `http://${displayHost}:${port}`;
  console.log(`[example] Docker demo: ${origin}`);
  console.log(
    `[example] WebSocket endpoint: ws://${displayHost}:${port}/terminal`,
  );
  console.warn(
    '[example] Docker socket access is host-equivalent; use only test-* containers.',
  );
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    console.warn(
      '[example] WARNING: this unauthenticated demo is listening beyond loopback.',
    );
  }
});
