import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';

const projectRoot = resolve(import.meta.dirname, '../..');
const exampleDirectory = resolve(projectRoot, 'examples/multiplexing');
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: exampleDirectory,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    LIT_SHELL_ALLOWED_ORIGINS: origin,
    LIT_SHELL_VERBOSE: 'false',
    PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let childError;
let logs = '';
child.once('error', (error) => {
  childError = error;
});
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    logs = `${logs}${chunk.toString()}`.slice(-16_384);
  });
}

try {
  await waitForHealth(`${origin}/healthz`);
  const serverInfo = await readServerInfo(
    `ws://127.0.0.1:${port}/terminal`,
    origin,
  );
  if (
    serverInfo.type !== 'serverInfo' ||
    serverInfo.info?.localEnabled !== true ||
    serverInfo.info?.dockerEnabled !== false ||
    !Array.isArray(serverInfo.info.allowedShells) ||
    !serverInfo.info.allowedShells.includes('/bin/sh')
  ) {
    throw new Error(
      `Multiplexing example returned invalid capabilities: ${JSON.stringify(serverInfo)}`,
    );
  }
  console.log('example-server-ok');
} catch (error) {
  throw new Error(`Multiplexing example smoke failed. Logs:\n${logs}`, {
    cause: error,
  });
} finally {
  await stopChild();
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not reserve an example server port');
  }
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHealth(url) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (childError) throw childError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Example exited early (${child.exitCode ?? child.signalCode})`,
      );
    }

    try {
      const response = await fetch(url);
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch {
      // The server may still be loading the native PTY dependency.
    }
    await delay(50);
  }
  throw new Error('Example health endpoint did not become ready');
}

async function readServerInfo(url, allowedOrigin) {
  const socket = new WebSocket(url, { origin: allowedOrigin });
  socket.on('error', () => undefined);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for serverInfo'));
      }, 5_000);
      const message = (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.type === 'serverInfo') {
            cleanup();
            resolve(parsed);
          }
        } catch (error) {
          failed(error);
        }
      };
      const failed = (error) => {
        cleanup();
        reject(error);
      };
      const closed = () =>
        failed(new Error('WebSocket closed before serverInfo'));
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('message', message);
        socket.off('error', failed);
        socket.off('close', closed);
      };

      socket.on('message', message);
      socket.once('error', failed);
      socket.once('close', closed);
    });
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
}

async function stopChild() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, 'exit');
  child.kill('SIGTERM');
  const graceful = await Promise.race([
    stopped.then(() => true),
    delay(3_000).then(() => false),
  ]);
  if (graceful) return;
  child.kill('SIGKILL');
  await stopped;
}
