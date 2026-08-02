import WebSocket from 'ws';

const endpoint = process.env.LIT_SHELL_SMOKE_URL;
const origin = process.env.LIT_SHELL_SMOKE_ORIGIN;
const targetContainer = process.env.LIT_SHELL_SMOKE_CONTAINER;

if (!endpoint || !origin || !targetContainer) {
  throw new Error('Docker protocol smoke environment is incomplete');
}

const socket = new WebSocket(endpoint, { origin });
const messages = [];
const listeners = new Set();

socket.on('message', (data) => {
  const message = JSON.parse(data.toString());
  messages.push(message);
  for (const listener of [...listeners]) listener();
});

const opened = new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});

function waitForMessage(predicate, description, timeout = 5_000) {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ${description}: ${JSON.stringify(messages)}`,
        ),
      );
    }, timeout);
    const scan = () => {
      const found = messages.find(predicate);
      if (found) {
        cleanup();
        resolve(found);
      }
    };
    const closed = () => {
      cleanup();
      reject(
        new Error(
          `WebSocket closed while waiting for ${description}: ${JSON.stringify(messages)}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      listeners.delete(scan);
      socket.off('close', closed);
    };

    listeners.add(scan);
    socket.once('close', closed);
    scan();
  });
}

try {
  await opened;
  const serverInfo = await waitForMessage(
    (message) => message.type === 'serverInfo',
    'server capabilities',
  );
  if (
    serverInfo.info?.localEnabled !== false ||
    serverInfo.info?.dockerEnabled !== true ||
    !Array.isArray(serverInfo.info.allowedShells) ||
    typeof serverInfo.info.defaultShell !== 'string'
  ) {
    throw new Error(
      `Server advertised an invalid capability envelope: ${JSON.stringify(serverInfo)}`,
    );
  }

  socket.send(
    JSON.stringify({
      type: 'spawn',
      requestId: 'blocked-local',
      options: { shell: '/bin/sh', cwd: '/tmp' },
    }),
  );
  const blockedLocal = await waitForMessage(
    (message) =>
      message.type === 'error' && message.requestId === 'blocked-local',
    'local execution rejection',
  );
  if (!/Local terminal execution is disabled/.test(blockedLocal.error ?? '')) {
    throw new Error(
      `Local spawn was not rejected safely: ${JSON.stringify(blockedLocal)}`,
    );
  }

  socket.send(JSON.stringify({ type: 'listContainers', requestId: 'list-1' }));
  const listing = await waitForMessage(
    (message) =>
      message.type === 'containerList' && message.requestId === 'list-1',
    'Docker container listing',
  );
  if (
    !Array.isArray(listing.containers) ||
    !listing.containers.some((container) => container.name === targetContainer)
  ) {
    throw new Error(
      `Allowed target was absent from listing: ${JSON.stringify(listing)}`,
    );
  }

  socket.send(
    JSON.stringify({
      type: 'spawn',
      requestId: 'spawn-1',
      options: {
        container: targetContainer,
        containerShell: '/bin/sh',
        containerCwd: '/tmp',
        env: { LIT_SHELL_DOCKER_SMOKE: 'docker-exec-ok' },
      },
    }),
  );
  const spawned = await waitForMessage(
    (message) => message.type === 'spawned' && message.requestId === 'spawn-1',
    'Docker exec session',
  );
  if (typeof spawned.sessionId !== 'string') {
    throw new Error(
      `Spawn response lacks a session ID: ${JSON.stringify(spawned)}`,
    );
  }

  const outputStart = messages.length;
  socket.send(
    JSON.stringify({
      type: 'data',
      sessionId: spawned.sessionId,
      data: `printf '%s:%s\\n' "$LIT_SHELL_DOCKER_SMOKE" "$PWD"\n`,
    }),
  );
  await waitForMessage(
    () =>
      messages
        .slice(outputStart)
        .filter(
          (message) =>
            message.type === 'data' && message.sessionId === spawned.sessionId,
        )
        .map((message) => message.data)
        .join('')
        .includes('docker-exec-ok:/tmp'),
    'Docker exec output',
  );

  socket.send(JSON.stringify({ type: 'close', sessionId: spawned.sessionId }));
  await waitForMessage(
    (message) =>
      message.sessionId === spawned.sessionId &&
      (message.type === 'exit' || message.type === 'sessionClosed'),
    'Docker session cleanup',
  );
  console.log('docker-protocol-ok');
} finally {
  if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
}
