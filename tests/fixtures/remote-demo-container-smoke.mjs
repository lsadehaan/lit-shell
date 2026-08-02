import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import { WebSocket } from 'ws';

const serviceOrigin =
  process.env.LIT_SHELL_SMOKE_ORIGIN ?? 'http://127.0.0.1:10000';
const browserOrigin =
  process.env.LIT_SHELL_SMOKE_BROWSER_ORIGIN ?? 'https://pages.test';
const hostCanary = process.env.LIT_SHELL_HOST_CANARY;
const expectedRevision =
  process.env.LIT_SHELL_EXPECTED_REVISION ?? process.env.RENDER_GIT_COMMIT;

assert.ok(
  hostCanary,
  'The container smoke test requires a host-environment canary',
);
assert.match(
  expectedRevision ?? '',
  /^[0-9a-f]{40}$/u,
  'The container smoke test requires an exact expected revision',
);

const live = await fetch(`${serviceOrigin}/health/live`);
assert.equal(live.status, 200);
assert.equal(live.headers.get('cache-control'), 'no-store');
assert.deepEqual(await live.json(), {
  revision: expectedRevision,
  status: 'live',
});

const ready = await fetch(`${serviceOrigin}/health/ready`, {
  headers: { Origin: browserOrigin },
});
assert.equal(ready.status, 200);
assert.equal(ready.headers.get('access-control-allow-origin'), browserOrigin);
assert.equal(ready.headers.get('access-control-expose-headers'), 'Retry-After');
assert.equal((await ready.json()).status, 'ready');

const wrongOrigin = await requestAdmission('https://attacker.test');
assert.equal(wrongOrigin.status, 403);

const grant = await issueAdmission();
const busy = await requestAdmission(browserOrigin);
assert.equal(busy.status, 429);
assert.equal(busy.headers.get('access-control-expose-headers'), 'Retry-After');
assert.ok(Number(busy.headers.get('retry-after')) > 0);

const webSocketUrl = `${serviceOrigin.replace(/^http/u, 'ws')}/terminal`;
await expectUpgradeRejected(webSocketUrl, ['lit-shell.v1'], 401);
await expectUpgradeRejected(
  webSocketUrl,
  ['lit-shell.v1', `lit-shell.admission.${grant.token}`],
  403,
  'https://attacker.test',
);

const first = await connect(grant.token);
assert.equal(first.socket.protocol, 'lit-shell.v1');
assert.ok(!first.socket.url.includes(grant.token));
await first.waitFor((message) => message.type === 'serverInfo');

first.send({
  options: { allowJoin: false, cols: 80, rows: 24 },
  requestId: 'sandbox-boundaries',
  type: 'spawn',
});
const spawned = await first.waitFor(
  (message) => message.requestId === 'sandbox-boundaries',
);
assert.equal(spawned.type, 'spawned');
assert.equal(typeof spawned.sessionId, 'string');
const sessionId = spawned.sessionId;
await first.waitForOutput(sessionId, 'lit-shell remote demo', 5_000);

const echoDisabledMarker = `__ECHO_DISABLED_${randomUUID().replaceAll('-', '')}__`;
first.send({
  data: `stty -echo; printf '${echoDisabledMarker}\\n'\n`,
  sessionId,
  type: 'data',
});
await first.waitForOutputOccurrences(sessionId, echoDisabledMarker, 2, 3_000);
first.clearOutput(sessionId);

const completionMarker = `__LIT_BOUNDARY_DONE_${randomUUID().replaceAll('-', '')}__`;

first.send({
  data: `${[
    "printf '\\n__LIT_BOUNDARY_START__\\n'",
    "printf 'UID='; id -u",
    "printf 'GID='; id -g",
    "printf 'GROUPS='; id -G",
    "printf 'PWD='; pwd",
    "printf 'ENV_START\\n'; env; printf 'ENV_END\\n'",
    "if printf pwned > /home/demo/pwned; then printf 'FS=WRITABLE\\n'; else printf 'FS=READ_ONLY\\n'; fi",
    "if [ -e /proc/self/status ]; then printf 'PROC=VISIBLE\\n'; else printf 'PROC=ABSENT\\n'; fi",
    "if [ -e /outside-canary ]; then printf 'OUTSIDE=VISIBLE\\n'; else printf 'OUTSIDE=ABSENT\\n'; fi",
    "if command -v curl || command -v wget || command -v nc || command -v node || command -v python3 || command -v cc; then printf 'TOOLS=UNSAFE\\n'; else printf 'TOOLS=CURATED\\n'; fi",
    "if kill -0 1; then printf 'PID1=SIGNALABLE\\n'; else printf 'PID1=PROTECTED\\n'; fi",
    `printf '${completionMarker}\\n'`,
  ].join(';')}\n`,
  sessionId,
  type: 'data',
});

const boundaryOutput = await first.waitForOutput(
  sessionId,
  completionMarker,
  5_000,
);
assert.match(boundaryOutput, /UID=65532\r?\n/u);
assert.match(boundaryOutput, /GID=65532\r?\n/u);
assert.match(boundaryOutput, /GROUPS=65532\r?\n/u);
assert.match(boundaryOutput, /PWD=\/home\/demo\r?\n/u);
assert.match(boundaryOutput, /FS=READ_ONLY\r?\n/u);
assert.match(boundaryOutput, /PROC=ABSENT\r?\n/u);
assert.match(boundaryOutput, /OUTSIDE=ABSENT\r?\n/u);
assert.match(boundaryOutput, /TOOLS=CURATED\r?\n/u);
assert.match(boundaryOutput, /PID1=PROTECTED\r?\n/u);
const environment = boundaryOutput.match(
  /ENV_START\r?\n(?<value>[\s\S]*?)ENV_END/u,
)?.groups?.value;
assert.ok(environment, 'The sandbox did not report its sanitized environment');
assert.match(environment, /HOME=\/home\/demo\r?\n/u);
assert.match(environment, /PATH=\/bin:\/usr\/bin\r?\n/u);
assert.ok(!environment.includes('LIT_SHELL_HOST_CANARY'));
assert.ok(!environment.includes(hostCanary));
assert.ok(!environment.includes('NODE_ENV='));

// Disconnect without asking the shell to exit. The gateway must retain the
// lease until the privileged supervisor proves that every sandbox process is
// gone and a fresh self-test can acquire its lock.
await first.close();

await expectUpgradeRejected(
  webSocketUrl,
  ['lit-shell.v1', `lit-shell.admission.${grant.token}`],
  401,
);

const cpuGrant = await issueAdmission();
const cpu = await connect(cpuGrant.token);
await cpu.waitFor((message) => message.type === 'serverInfo');
cpu.send({ requestId: 'cpu-session', type: 'spawn' });
const cpuSpawned = await cpu.waitFor(
  (message) => message.requestId === 'cpu-session',
);
assert.equal(cpuSpawned.type, 'spawned');
assert.equal(typeof cpuSpawned.sessionId, 'string');
await cpu.waitForOutput(cpuSpawned.sessionId, 'lit-shell remote demo', 5_000);
const cpuStartedAt = performance.now();
cpu.send({
  data: 'while :; do :; done\n',
  sessionId: cpuSpawned.sessionId,
  type: 'data',
});
const cpuExit = await cpu.waitFor(
  (message) =>
    message.type === 'exit' && message.sessionId === cpuSpawned.sessionId,
  58_000,
);
const cpuClosed = await cpu.waitFor(
  (message) =>
    message.type === 'sessionClosed' &&
    message.sessionId === cpuSpawned.sessionId,
  58_000,
);
assert.equal(cpuExit.exitCode, 152);
assert.ok(
  performance.now() - cpuStartedAt >= 3_500,
  'The CPU-bound shell exited too quickly to have reached RLIMIT_CPU',
);
assert.equal(cpuClosed.reason, 'process_exit');
await cpu.close();

const finalReady = await waitForAvailableReadiness();
assert.equal(finalReady.status, 200);
assert.equal((await finalReady.json()).admission, 'available');

console.log('remote demo container smoke test passed');

async function requestAdmission(origin) {
  return fetch(`${serviceOrigin}/v1/admissions`, {
    headers: { Origin: origin },
    method: 'POST',
  });
}

async function issueAdmission() {
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    const response = await requestAdmission(browserOrigin);
    if (response.status === 201) {
      const value = await response.json();
      assert.equal(value.protocol, 'lit-shell.v1');
      assert.equal(value.webSocketPath, '/terminal');
      assert.match(value.token, /^[A-Za-z0-9_-]{43}$/u);
      return value;
    }
    assert.ok(
      response.status === 429 || response.status === 503,
      `Expected a busy or recovering gateway, received ${String(response.status)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The sandbox lease was not released after verified cleanup');
}

async function waitForAvailableReadiness() {
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${serviceOrigin}/health/ready`);
    if (response.ok) {
      const value = await response.clone().json();
      if (value.admission === 'available') return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The gateway did not become available after sandbox cleanup');
}

async function expectUpgradeRejected(
  url,
  protocols,
  expectedStatus,
  origin = browserOrigin,
) {
  const socket = new WebSocket(url, protocols, { origin });
  socket.on('error', () => undefined);
  const [request, response] = await once(socket, 'unexpected-response');
  assert.equal(response.statusCode, expectedStatus);
  response.resume();
  request.destroy();
}

async function connect(token) {
  const socket = new WebSocket(
    webSocketUrl,
    ['lit-shell.v1', `lit-shell.admission.${token}`],
    { origin: browserOrigin },
  );
  const messages = [];
  const output = new Map();
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    if (
      message.type === 'data' &&
      typeof message.sessionId === 'string' &&
      typeof message.data === 'string'
    ) {
      output.set(
        message.sessionId,
        `${output.get(message.sessionId) ?? ''}${message.data}`,
      );
    }
  });
  await once(socket, 'open');

  return {
    socket,
    send(message) {
      socket.send(JSON.stringify(message));
    },
    async waitFor(predicate, timeout = 3_000) {
      return waitUntil(() => messages.find(predicate), timeout);
    },
    async waitForOutput(sessionId, marker, timeout) {
      return waitUntil(() => {
        const current = output.get(sessionId) ?? '';
        return current.includes(marker) ? current : undefined;
      }, timeout);
    },
    async waitForOutputOccurrences(sessionId, marker, count, timeout) {
      return waitUntil(() => {
        const current = output.get(sessionId) ?? '';
        const occurrences = current.split(marker).length - 1;
        return occurrences >= count ? current : undefined;
      }, timeout);
    },
    clearOutput(sessionId) {
      output.set(sessionId, '');
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = once(socket, 'close');
      socket.close();
      await closed;
    },
  };
}

async function waitUntil(check, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${String(timeout)}ms`);
}
