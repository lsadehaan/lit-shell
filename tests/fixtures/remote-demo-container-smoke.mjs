import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, readFile, readdir } from 'node:fs/promises';

import { WebSocket } from 'ws';

const serviceOrigin =
  process.env.LIT_SHELL_SMOKE_ORIGIN ?? 'http://127.0.0.1:10000';
const browserOrigin =
  process.env.LIT_SHELL_SMOKE_BROWSER_ORIGIN ?? 'https://example.com';
const hostCanary = process.env.LIT_SHELL_HOST_CANARY;
const expectedRevision =
  process.env.LIT_SHELL_EXPECTED_REVISION ?? process.env.RENDER_GIT_COMMIT;
const dummyTurnstileToken = 'XXXX.DUMMY.TOKEN.XXXX';
const webSocketUrl = `${serviceOrigin.replace(/^http/u, 'ws')}/terminal`;
const sharedHostPaths = [
  { label: 'TMP', path: '/tmp' },
  { label: 'VAR_TMP', path: '/var/tmp' },
  { label: 'RUN_LOCK', path: '/run/lock' },
  { label: 'DEV_SHM', path: '/dev/shm' },
  { label: 'DEV_MQUEUE', path: '/dev/mqueue' },
];

assert.ok(hostCanary, 'The smoke test requires a gateway environment canary');
assert.match(expectedRevision ?? '', /^[0-9a-f]{40}$/u);

const initialLive = await fetch(`${serviceOrigin}/health/live`);
assert.equal(initialLive.status, 200);
assert.equal(initialLive.headers.get('cache-control'), 'no-store');
const initialHealth = await initialLive.json();
assert.equal(initialHealth.revision, expectedRevision);
assert.equal(initialHealth.status, 'live');
assert.equal(initialHealth.epoch, 1);
assert.ok(Date.parse(initialHealth.resetAt) > Date.now());

const gatewayStatus = await findGatewayStatus();
for (const capabilitySet of ['CapBnd', 'CapEff', 'CapPrm']) {
  assert.match(
    gatewayStatus,
    new RegExp(`^${capabilitySet}:\\s+0{14}e3$`, 'mu'),
  );
}
assert.match(gatewayStatus, /^CapAmb:\s+0{16}$/mu);
assert.match(gatewayStatus, /^CapInh:\s+0{16}$/mu);
assert.match(gatewayStatus, /^Groups:\s*$/mu);

const ready = await fetch(`${serviceOrigin}/health/ready`, {
  headers: { Origin: browserOrigin },
});
assert.equal(ready.status, 200);
assert.equal(ready.headers.get('access-control-allow-origin'), browserOrigin);
assert.equal(ready.headers.get('access-control-expose-headers'), 'Retry-After');
assert.deepEqual((await ready.json()).admission, {
  active: 0,
  capacity: 4,
  pending: 0,
});

assert.equal((await requestAdmission('https://attacker.test')).status, 403);
assert.equal(
  (
    await fetch(`${serviceOrigin}/v1/admissions`, {
      headers: { Origin: browserOrigin },
      method: 'POST',
    })
  ).status,
  415,
);
await expectUpgradeRejected(webSocketUrl, ['lit-shell.v1'], 401);

const grants = await Promise.all(Array.from({ length: 4 }, issueAdmission));
const clients = await Promise.all(grants.map((grant) => connect(grant.token)));
for (const client of clients) {
  assert.equal(client.socket.protocol, 'lit-shell.v1');
  await client.waitFor((message) => message.type === 'serverInfo');
}
const full = await requestAdmission(browserOrigin);
assert.equal(full.status, 429);
assert.ok(Number(full.headers.get('retry-after')) > 0);

const first = clients[0];
const second = clients[1];
assert.ok(first && second);
const firstSession = await spawn(first, 'first');
const secondSession = await spawn(second, 'second');
await Promise.all([
  disableEcho(first, firstSession),
  disableEcho(second, secondSession),
]);
const marker = `shared-${randomUUID().replaceAll('-', '')}`;
const backgroundMarker = `background-${randomUUID().replaceAll('-', '')}`;
const hostPathProbe = `lit-shell-${randomUUID().replaceAll('-', '')}`;

first.send({
  data: `printf '${marker}' > shared.txt; sleep 1000 & printf '${backgroundMarker}=%s\\n' "$!"\n`,
  sessionId: firstSession,
  type: 'data',
});
const backgroundOutput = await first.waitForOutput(
  firstSession,
  backgroundMarker,
  5_000,
);
const backgroundPid = Number(
  backgroundOutput.match(new RegExp(`${backgroundMarker}=(?<pid>[0-9]+)`, 'u'))
    ?.groups?.pid,
);
assert.ok(Number.isInteger(backgroundPid) && backgroundPid > 1);

second.send({
  data: `${[
    "printf '__BOUNDARY_START__\\n'",
    "printf 'UID='; id -u",
    "printf 'GID='; id -g",
    "printf 'GROUPS='; id -G",
    "printf 'PWD='; pwd",
    "printf 'SHARED='; cat shared.txt",
    "printf '\\nNOFILE='; ulimit -n",
    "printf 'FILEBLOCKS='; ulimit -f",
    "if touch /app/guest-write 2>/dev/null; then printf 'APP=WRITABLE\\n'; else printf 'APP=READ_ONLY\\n'; fi",
    ...sharedHostPaths.flatMap(({ label, path }) => [
      `if [ -d '${path}' ] && [ ! -L '${path}' ]; then printf '${label}_REAL=YES\\n'; else printf '${label}_REAL=NO\\n'; fi`,
      `printf '${label}_OWNER='; stat -c '%u:%g' '${path}'`,
      `printf '${label}_MODE='; stat -c '%a' '${path}'`,
      `if touch '${path}/${hostPathProbe}' 2>/dev/null; then printf '${label}=WRITABLE\\n'; rm -f '${path}/${hostPathProbe}'; else printf '${label}=READ_ONLY\\n'; fi`,
    ]),
    'sysv_shm="$(ipcmk -M 4096)"',
    'sysv_msg="$(ipcmk -Q)"',
    'sysv_sem="$(ipcmk -S 1)"',
    `printf 'SYSV_SHM=%s\\n' "\${sysv_shm##*: }"`,
    `printf 'SYSV_MSG=%s\\n' "\${sysv_msg##*: }"`,
    `printf 'SYSV_SEM=%s\\n' "\${sysv_sem##*: }"`,
    "if [ -x /usr/local/bin/node ]; then printf 'NODE=EXECUTABLE\\n'; else printf 'NODE=BLOCKED\\n'; fi",
    "if kill -0 1 2>/dev/null; then printf 'PID1=SIGNALABLE\\n'; else printf 'PID1=PROTECTED\\n'; fi",
    "if cat /proc/1/environ >/dev/null 2>&1; then printf 'ROOTENV=READABLE\\n'; else printf 'ROOTENV=PROTECTED\\n'; fi",
    "printf 'ENV_START\\n'; env; printf 'ENV_END\\n'",
    "printf '__BOUNDARY_DONE__\\n'",
  ].join(';')}\n`,
  sessionId: secondSession,
  type: 'data',
});
const boundary = await second.waitForOutput(
  secondSession,
  '__BOUNDARY_DONE__',
  7_000,
);
assert.match(boundary, /UID=65532\r?\n/u);
assert.match(boundary, /GID=65532\r?\n/u);
assert.match(boundary, /GROUPS=65532\r?\n/u);
assert.match(boundary, /PWD=\/workspace\/shared\r?\n/u);
assert.match(boundary, new RegExp(`SHARED=${marker}`, 'u'));
assert.match(boundary, /NOFILE=64\r?\n/u);
assert.match(boundary, /FILEBLOCKS=16384\r?\n/u);
assert.match(boundary, /APP=READ_ONLY\r?\n/u);
for (const { label } of sharedHostPaths) {
  assert.match(boundary, new RegExp(`${label}_REAL=YES\\r?\\n`, 'u'));
  assert.match(boundary, new RegExp(`${label}_OWNER=0:0\\r?\\n`, 'u'));
  assert.match(boundary, new RegExp(`${label}_MODE=755\\r?\\n`, 'u'));
  assert.match(boundary, new RegExp(`${label}=READ_ONLY\\r?\\n`, 'u'));
}
assert.match(boundary, /NODE=BLOCKED\r?\n/u);
assert.match(boundary, /PID1=PROTECTED\r?\n/u);
assert.match(boundary, /ROOTENV=PROTECTED\r?\n/u);
const environment = boundary.match(/ENV_START\r?\n(?<value>[\s\S]*?)ENV_END/u)
  ?.groups?.value;
assert.ok(environment);
assert.match(environment, /HOME=\/workspace\/shared\r?\n/u);
assert.match(environment, /TMPDIR=\/workspace\/shared\/tmp\r?\n/u);
assert.ok(!environment.includes('LIT_SHELL_TURNSTILE_SECRET_KEY'));
assert.ok(!environment.includes('LIT_SHELL_HOST_CANARY'));
assert.ok(!environment.includes(hostCanary));

const ipcResources = [
  { id: ipcId(boundary, 'SYSV_SHM'), table: 'shm' },
  { id: ipcId(boundary, 'SYSV_MSG'), table: 'msg' },
  { id: ipcId(boundary, 'SYSV_SEM'), table: 'sem' },
];
for (const resource of ipcResources) {
  const owner = await sysVIpcOwner(resource.table, resource.id);
  assert.deepEqual(owner, { gid: 65_532, uid: 65_532 });
}

const closes = clients.map((client) => once(client.socket, 'close'));
process.kill(1, 'SIGUSR2');
for (const closed of closes) {
  const [code, reason] = await closed;
  assert.equal(code, 1012);
  assert.equal(reason.toString(), 'Shared demo reset');
}

const afterReset = await waitForEpoch(2);
assert.equal(afterReset.status, 'ready');
assert.deepEqual(afterReset.admission, {
  active: 0,
  capacity: 4,
  pending: 0,
});
await assert.rejects(access(`/proc/${String(backgroundPid)}`));
for (const resource of ipcResources) {
  assert.equal(await sysVIpcOwner(resource.table, resource.id), undefined);
}

const replacementGrant = await issueAdmission();
const replacement = await connect(replacementGrant.token);
await replacement.waitFor((message) => message.type === 'serverInfo');
const replacementSession = await spawn(replacement, 'replacement');
replacement.send({
  data: "if [ -e shared.txt ]; then printf 'STALE\\n'; else printf 'RESET_OK\\n'; fi\n",
  sessionId: replacementSession,
  type: 'data',
});
await replacement.waitForOutput(replacementSession, 'RESET_OK', 5_000);
await replacement.close();

await expectUpgradeRejected(
  webSocketUrl,
  ['lit-shell.v1', `lit-shell.admission.${replacementGrant.token}`],
  401,
);

console.log('shared remote demo container smoke test passed');

function ipcId(output, label) {
  const id = Number(
    output.match(new RegExp(`${label}=(?<id>[0-9]+)\\r?\\n`, 'u'))?.groups?.id,
  );
  assert.ok(Number.isSafeInteger(id) && id >= 0, `${label} was not created`);
  return id;
}

async function sysVIpcOwner(table, id) {
  const idColumn = { msg: 'msqid', sem: 'semid', shm: 'shmid' }[table];
  assert.ok(idColumn);
  const lines = (await readFile(`/proc/sysvipc/${table}`, 'utf8'))
    .trim()
    .split('\n');
  const headings = lines.shift()?.trim().split(/\s+/u) ?? [];
  const idIndex = headings.indexOf(idColumn);
  const uidIndex = headings.indexOf('uid');
  const gidIndex = headings.indexOf('gid');
  assert.ok(idIndex >= 0 && uidIndex >= 0 && gidIndex >= 0);
  for (const line of lines) {
    const values = line.trim().split(/\s+/u);
    if (Number(values[idIndex]) === id) {
      return {
        gid: Number(values[gidIndex]),
        uid: Number(values[uidIndex]),
      };
    }
  }
  return undefined;
}

async function findGatewayStatus() {
  const entries = await readdir('/proc', { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
    try {
      const commandLine = await readFile(`/proc/${entry.name}/cmdline`, 'utf8');
      const arguments_ = commandLine.split('\0').filter(Boolean);
      if (
        !['node', '/usr/local/bin/node'].includes(arguments_[0] ?? '') ||
        arguments_[1] !== '/app/remote-shell-server.mjs'
      ) {
        continue;
      }
      return readFile(`/proc/${entry.name}/status`, 'utf8');
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('Could not find the root gateway process');
}

function requestAdmission(origin) {
  return fetch(`${serviceOrigin}/v1/admissions`, {
    body: new URLSearchParams({ turnstileToken: dummyTurnstileToken }),
    headers: { Origin: origin },
    method: 'POST',
  });
}

async function issueAdmission() {
  const response = await requestAdmission(browserOrigin);
  assert.equal(response.status, 201);
  const value = await response.json();
  assert.equal(value.protocol, 'lit-shell.v1');
  assert.equal(value.webSocketPath, '/terminal');
  assert.match(value.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.ok(Date.parse(value.resetAt) > Date.now());
  return value;
}

async function spawn(client, requestId) {
  client.send({
    options: { allowJoin: false, cols: 80, rows: 24 },
    requestId,
    type: 'spawn',
  });
  const message = await client.waitFor(
    (value) => value.requestId === requestId,
  );
  assert.equal(message.type, 'spawned');
  assert.equal(typeof message.sessionId, 'string');
  return message.sessionId;
}

async function disableEcho(client, sessionId) {
  const marker = `echo-disabled-${randomUUID().replaceAll('-', '')}`;
  const octalMarker = Array.from(
    Buffer.from(marker, 'utf8'),
    (byte) => `\\${byte.toString(8).padStart(3, '0')}`,
  ).join('');
  client.send({
    data: `stty -echo; printf '${octalMarker}\\n'\n`,
    sessionId,
    type: 'data',
  });
  await client.waitForOutput(sessionId, marker, 5_000);
  client.clearOutput(sessionId);
}

async function waitForEpoch(epoch) {
  return waitUntil(async () => {
    const response = await fetch(`${serviceOrigin}/health/ready`);
    if (!response.ok) return undefined;
    const value = await response.json();
    return value.epoch === epoch ? value : undefined;
  }, 8_000);
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
    waitFor(predicate, timeout = 3_000) {
      return waitUntil(() => messages.find(predicate), timeout);
    },
    waitForOutput(sessionId, marker, timeout) {
      return waitUntil(() => {
        const current = output.get(sessionId) ?? '';
        return current.includes(marker) ? current : undefined;
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
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${String(timeout)}ms`);
}
