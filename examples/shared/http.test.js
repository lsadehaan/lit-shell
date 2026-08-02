import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  parseAllowedOrigins,
  parsePort,
  parseRequestPath,
  resolveContainedFile,
  sendFile,
} from './http.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lit-shell-http-'));
  temporaryDirectories.push(directory);
  const publicRoot = join(directory, 'public');
  await mkdir(publicRoot);
  await writeFile(join(publicRoot, 'app.js'), 'export const safe = true;\n');
  await writeFile(join(directory, 'secret.txt'), 'not public\n');
  return { directory, publicRoot };
}

async function listen(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(error);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('validates configured network ports strictly', () => {
  assert.equal(parsePort(undefined), 3000);
  assert.equal(parsePort('1'), 1);
  assert.equal(parsePort('65535'), 65_535);
  assert.throws(() => parsePort('3000junk'), /integer/);
  assert.throws(() => parsePort('0'), /between 1 and 65535/);
  assert.throws(() => parsePort('65536'), /between 1 and 65535/);
});

test('defaults WebSocket origins to exact local HTTP origins', () => {
  assert.deepEqual(parseAllowedOrigins(undefined, 4173), [
    'http://127.0.0.1:4173',
    'http://localhost:4173',
    'http://[::1]:4173',
  ]);
  assert.deepEqual(
    parseAllowedOrigins(
      'https://terminal.example.com,http://localhost:4173,https://terminal.example.com',
      4173,
    ),
    ['https://terminal.example.com', 'http://localhost:4173'],
  );
});

test('rejects empty, non-HTTP, and non-origin WebSocket origin settings', () => {
  assert.throws(() => parseAllowedOrigins('', 3000), /empty values/);
  assert.throws(
    () => parseAllowedOrigins('https://terminal.example.com/path', 3000),
    /canonical HTTP\(S\) origins without paths/,
  );
  assert.throws(
    () => parseAllowedOrigins('file:///tmp/terminal.html', 3000),
    /canonical HTTP\(S\) origins without paths/,
  );
  assert.throws(
    () => parseAllowedOrigins('not an origin', 3000),
    /valid HTTP\(S\) origins/,
  );
});

test('resolves regular files inside the configured root', async () => {
  const { publicRoot } = await fixture();
  assert.equal(
    await resolveContainedFile(publicRoot, '/app.js'),
    join(publicRoot, 'app.js'),
  );
});

test('rejects decoded traversal and symlink escapes', async () => {
  const { directory, publicRoot } = await fixture();
  await symlink(join(directory, 'secret.txt'), join(publicRoot, 'link.txt'));

  const decodedTraversal = parseRequestPath(
    { method: 'GET', url: '/..%2fsecret.txt' },
    {},
  );

  assert.equal(decodedTraversal, '/../secret.txt');
  assert.equal(await resolveContainedFile(publicRoot, decodedTraversal), null);
  assert.equal(await resolveContainedFile(publicRoot, '/link.txt'), null);
});

test('serves GET and HEAD with safe headers and rejects other methods', async () => {
  const { publicRoot } = await fixture();
  const app = await listen(async (request, response) => {
    const pathname = parseRequestPath(request, response);
    if (pathname !== null) {
      await sendFile(request, response, { root: publicRoot, pathname });
    }
  });

  try {
    const getResponse = await fetch(`${app.origin}/app.js`);
    assert.equal(getResponse.status, 200);
    assert.equal(
      getResponse.headers.get('content-type'),
      'text/javascript; charset=utf-8',
    );
    assert.equal(getResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await getResponse.text(), /safe = true/);

    const headResponse = await fetch(`${app.origin}/app.js`, {
      method: 'HEAD',
    });
    assert.equal(headResponse.status, 200);
    assert.equal(await headResponse.text(), '');

    const postResponse = await fetch(`${app.origin}/app.js`, {
      method: 'POST',
    });
    assert.equal(postResponse.status, 405);
    assert.equal(postResponse.headers.get('allow'), 'GET, HEAD');
  } finally {
    await app.close();
  }
});
