import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2'],
]);

const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self' ws: wss:",
    "font-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "script-src 'self'",
    "style-src 'self'",
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

export function parsePort(value, fallback = 3000) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error('PORT must be an integer');

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be between 1 and 65535');
  }
  return port;
}

export function parseAllowedOrigins(value, localPort) {
  const candidates =
    value === undefined
      ? [
          `http://127.0.0.1:${localPort}`,
          `http://localhost:${localPort}`,
          `http://[::1]:${localPort}`,
        ]
      : value.split(',');
  const origins = candidates.map((candidate) => candidate.trim());

  if (origins.length === 0 || origins.some((origin) => origin.length === 0)) {
    throw new Error('LIT_SHELL_ALLOWED_ORIGINS must not contain empty values');
  }

  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(
        'LIT_SHELL_ALLOWED_ORIGINS must contain valid HTTP(S) origins',
      );
    }

    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.origin !== origin
    ) {
      throw new Error(
        'LIT_SHELL_ALLOWED_ORIGINS must contain canonical HTTP(S) origins without paths',
      );
    }
  }

  return [...new Set(origins)];
}

function isContained(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(
      `..${process.platform === 'win32' ? '\\' : '/'}`,
    ) &&
      pathFromRoot !== '..' &&
      !isAbsolute(pathFromRoot))
  );
}

function endResponse(request, response, statusCode, body, headers = {}) {
  const encodedBody = Buffer.from(body);
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'Content-Length': encodedBody.byteLength,
    ...headers,
  });
  response.end(request.method === 'HEAD' ? undefined : encodedBody);
}

export function parseRequestPath(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    endResponse(request, response, 405, 'Method not allowed\n', {
      Allow: 'GET, HEAD',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return null;
  }

  let requestUrl;
  try {
    requestUrl = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    endResponse(request, response, 400, 'Bad request\n', {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return null;
  }

  try {
    const pathname = decodeURIComponent(requestUrl.pathname);
    if (pathname.includes('\0')) throw new URIError('NUL byte');
    return pathname;
  } catch {
    endResponse(request, response, 400, 'Bad request\n', {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return null;
  }
}

export async function resolveContainedFile(root, pathname) {
  const canonicalRoot = await realpath(root);
  const relativePath = pathname.replace(/^[/\\]+/, '');
  const unresolvedCandidate = resolve(canonicalRoot, relativePath);

  if (!isContained(canonicalRoot, unresolvedCandidate)) return null;

  let canonicalCandidate;
  try {
    canonicalCandidate = await realpath(unresolvedCandidate);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }

  if (!isContained(canonicalRoot, canonicalCandidate)) return null;
  const fileStats = await stat(canonicalCandidate);
  return fileStats.isFile() ? canonicalCandidate : null;
}

export async function sendFile(request, response, { root, pathname }) {
  const filename = await resolveContainedFile(root, pathname);
  if (filename === null) {
    sendText(request, response, 404, 'Not found\n');
    return;
  }

  const body = await readFile(filename);
  const contentType = CONTENT_TYPES.get(extname(filename).toLowerCase());
  if (contentType === undefined) {
    sendText(request, response, 415, 'Unsupported media type\n');
    return;
  }

  endResponse(request, response, 200, body, { 'Content-Type': contentType });
}

export function sendJson(request, response, statusCode, value) {
  endResponse(request, response, statusCode, `${JSON.stringify(value)}\n`, {
    'Content-Type': 'application/json; charset=utf-8',
  });
}

export function sendText(request, response, statusCode, body) {
  endResponse(request, response, statusCode, body, {
    'Content-Type': 'text/plain; charset=utf-8',
  });
}

export function reportRequestFailure(response, error) {
  console.error(
    '[example] HTTP request failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(500, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
  });
  response.end('Internal server error\n');
}
