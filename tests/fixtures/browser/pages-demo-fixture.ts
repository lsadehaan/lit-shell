import { once } from 'node:events';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';

export interface PagesDemoFixture {
  readonly origin: string;
  readonly pageUrl: string;
  close(): Promise<void>;
}

const projectPrefix = '/lit-shell/';
const contentTypes: Readonly<Record<string, string>> = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
});

export async function startPagesDemoFixture(): Promise<PagesDemoFixture> {
  let siteRoot: string;
  try {
    siteRoot = await realpath(resolve(process.cwd(), '_site'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        'Pages artifact is missing; run `npm run pages:check` before browser tests',
        { cause: error },
      );
    }
    throw error;
  }
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' }).end();
        return;
      }

      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      if (!requestUrl.pathname.startsWith(projectPrefix)) {
        response.writeHead(404).end('Not found\n');
        return;
      }

      const encodedPath = requestUrl.pathname.slice(projectPrefix.length);
      let relativePath: string;
      try {
        relativePath = decodeURIComponent(encodedPath || 'index.html');
      } catch {
        response.writeHead(400).end('Bad request\n');
        return;
      }
      if (
        relativePath.includes('\0') ||
        relativePath.includes('\\') ||
        relativePath.startsWith('/')
      ) {
        response.writeHead(400).end('Bad request\n');
        return;
      }

      const unresolvedPath = resolve(siteRoot, relativePath);
      if (
        unresolvedPath !== siteRoot &&
        !unresolvedPath.startsWith(`${siteRoot}${sep}`)
      ) {
        response.writeHead(403).end('Forbidden\n');
        return;
      }

      let filePath: string;
      try {
        filePath = await realpath(unresolvedPath);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        ) {
          response.writeHead(404).end('Not found\n');
          return;
        }
        throw error;
      }
      if (filePath !== siteRoot && !filePath.startsWith(`${siteRoot}${sep}`)) {
        response.writeHead(403).end('Forbidden\n');
        return;
      }
      if (!(await stat(filePath)).isFile()) {
        response.writeHead(404).end('Not found\n');
        return;
      }

      const body = await readFile(filePath);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': body.byteLength,
        'content-type':
          contentTypes[extname(filePath)] ?? 'application/octet-stream',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      console.error('Pages demo fixture request failed', error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response
        .writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        .end('Internal server error\n');
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not determine the Pages fixture address');
  }

  const origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    origin,
    pageUrl: `${origin}${projectPrefix}`,
    async close() {
      await closeServer(server);
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}
