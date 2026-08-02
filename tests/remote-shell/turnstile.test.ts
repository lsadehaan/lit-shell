import { describe, expect, it, vi } from 'vitest';

import {
  createTurnstileVerifier,
  TurnstileUnavailableError,
  VerificationAttemptLimiter,
} from '../../deploy/remote-shell/turnstile.js';

const NOW = Date.parse('2026-08-02T12:00:00.000Z');
const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function validResult(overrides: Record<string, unknown> = {}) {
  return {
    action: 'remote_shell_admission',
    challenge_ts: new Date(NOW).toISOString(),
    hostname: 'www.idnteq.net',
    success: true,
    ...overrides,
  };
}

function jsonResponse(
  value: unknown,
  init: { headers?: HeadersInit; status?: number } = {},
): Response {
  return new Response(JSON.stringify(value), {
    headers: init.headers,
    status: init.status ?? 200,
  });
}

function verifierWith(fetchImplementation: typeof fetch) {
  return createTurnstileVerifier({
    expectedAction: 'remote_shell_admission',
    expectedHostname: 'www.idnteq.net',
    fetch: fetchImplementation,
    idempotencyKeySource: () => 'fixed-idempotency-key',
    now: () => NOW,
    secretKey: 'private-secret',
    timeoutMs: 1_234,
  });
}

describe('Turnstile verifier', () => {
  it('sends a constrained Siteverify request and accepts an exact result', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(validResult()));
    const verifier = verifierWith(fetchMock);

    await expect(verifier.verify('browser-turnstile-token')).resolves.toBe(
      true,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(SITEVERIFY_URL);
    expect(init).toMatchObject({
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      idempotency_key: 'fixed-idempotency-key',
      response: 'browser-turnstile-token',
      secret: 'private-secret',
    });
  });

  it('supports test responses without an action', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          validResult({ action: undefined, hostname: 'example.com' }),
        ),
      );
    const verifier = createTurnstileVerifier({
      expectedHostname: 'example.com',
      fetch: fetchMock,
      now: () => NOW,
      secretKey: 'test-secret',
    });

    await expect(verifier.verify('token')).resolves.toBe(true);
  });

  it.each(['', 'x'.repeat(2_049)])(
    'rejects an invalid token length without contacting Cloudflare',
    async (token) => {
      const fetchMock = vi.fn<typeof fetch>();

      await expect(verifierWith(fetchMock).verify(token)).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['x', 'x'.repeat(2_048)])(
    'accepts token length boundary of %s bytes',
    async (token) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse(validResult()));

      await expect(verifierWith(fetchMock).verify(token)).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['success is absent', { success: undefined }],
    ['success has the wrong type', { success: 'true' }],
    ['hostname is absent', { hostname: undefined }],
    ['hostname differs', { hostname: 'evil.example' }],
    ['action is absent', { action: undefined }],
    ['action differs', { action: 'another_action' }],
    ['timestamp is absent', { challenge_ts: undefined }],
    ['timestamp has the wrong type', { challenge_ts: NOW }],
    ['timestamp is malformed', { challenge_ts: 'not-a-date' }],
  ])('rejects a successful response when %s', async (_name, override) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(validResult(override)));

    await expect(verifierWith(fetchMock).verify('token')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [-300_000, true],
    [-300_001, false],
    [30_000, true],
    [30_001, false],
  ])(
    'enforces challenge age offset %dms (valid=%s)',
    async (offset, expected) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          validResult({
            challenge_ts: new Date(NOW + offset).toISOString(),
          }),
        ),
      );

      await expect(verifierWith(fetchMock).verify('token')).resolves.toBe(
        expected,
      );
    },
  );

  it('treats an ordinary verification rejection as invalid without retrying', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        'error-codes': ['invalid-input-response'],
        success: false,
      }),
    );

    await expect(verifierWith(fetchMock).verify('token')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['error codes are absent', undefined],
    ['error codes have the wrong type', 'internal-error'],
    ['error codes do not include the transient code', ['invalid-input-secret']],
  ])('does not retry a failed result when %s', async (_name, errorCodes) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        'error-codes': errorCodes,
        success: false,
      }),
    );

    await expect(verifierWith(fetchMock).verify('token')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([429, 500, 503])(
    'retries transient HTTP status %d once with the same idempotency key',
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(jsonResponse(validResult()));

      await expect(verifierWith(fetchMock).verify('token')).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const requestBodies = fetchMock.mock.calls.map(
        ([, init]) => init?.body as URLSearchParams,
      );
      expect(requestBodies.map((body) => body.get('idempotency_key'))).toEqual([
        'fixed-idempotency-key',
        'fixed-idempotency-key',
      ]);
    },
  );

  it('retries an internal-error response once', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          'error-codes': ['internal-error'],
          success: false,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(validResult()));

    await expect(verifierWith(fetchMock).verify('token')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a transport failure once', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(jsonResponse(validResult()));

    await expect(verifierWith(fetchMock).verify('token')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new Response(null, { status: 503 }), new Response(null, { status: 429 })],
    [
      jsonResponse({
        'error-codes': ['internal-error'],
        success: false,
      }),
      new Response(null, { status: 500 }),
    ],
  ])('fails closed after two transient failures', async (first, second) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    await expect(
      verifierWith(fetchMock).verify('token'),
    ).rejects.toBeInstanceOf(TurnstileUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('creates one idempotency key per logical verification, not per retry', async () => {
    let key = 0;
    const keySource = vi.fn(() => `key-${String(++key)}`);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(validResult()))
      .mockResolvedValueOnce(jsonResponse(validResult()));
    const verifier = createTurnstileVerifier({
      expectedAction: 'remote_shell_admission',
      expectedHostname: 'www.idnteq.net',
      fetch: fetchMock,
      idempotencyKeySource: keySource,
      now: () => NOW,
      secretKey: 'secret',
    });

    await expect(verifier.verify('first')).resolves.toBe(true);
    await expect(verifier.verify('second')).resolves.toBe(true);
    expect(keySource).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(([, init]) =>
        (init?.body as URLSearchParams).get('idempotency_key'),
      ),
    ).toEqual(['key-1', 'key-1', 'key-2']);
  });

  it.each([
    ['a non-retryable HTTP response', new Response(null, { status: 400 })],
    ['malformed JSON', new Response('{not-json')],
    [
      'an oversized declared body',
      new Response('{}', { headers: { 'content-length': '16385' } }),
    ],
    ['an oversized streamed body', new Response('x'.repeat(16_385))],
  ])('fails closed on %s', async (_name, response) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(
      verifierWith(fetchMock).verify('token'),
    ).rejects.toBeInstanceOf(TurnstileUnavailableError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [{ expectedHostname: '', secretKey: 'secret' }, 'expectedHostname'],
    [{ expectedHostname: 'example.com', secretKey: '' }, 'secretKey'],
    [
      { expectedHostname: 'example.com', secretKey: 'secret', timeoutMs: 0 },
      'timeoutMs',
    ],
    [
      {
        expectedHostname: 'example.com',
        secretKey: 'secret',
        timeoutMs: 1.5,
      },
      'timeoutMs',
    ],
  ])('rejects invalid verifier options %#', (options, name) => {
    expect(() => createTurnstileVerifier(options)).toThrow(name);
  });
});

describe('Turnstile verification attempt limiter', () => {
  it('caps concurrency without charging rejected attempts and releases exactly once', () => {
    const limiter = new VerificationAttemptLimiter({
      burst: 2,
      maxConcurrent: 1,
      now: () => 1_000,
      refillIntervalMs: 1_000,
    });

    const release = limiter.begin();
    expect(release).toBeTypeOf('function');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.begin()).toBeUndefined();
    }
    release!();
    release!();
    const secondRelease = limiter.begin();
    expect(secondRelease).toBeTypeOf('function');
    secondRelease!();
    expect(limiter.begin()).toBeUndefined();
  });

  it('refills continuously while preserving the configured burst ceiling', () => {
    let now = 1_000;
    const limiter = new VerificationAttemptLimiter({
      burst: 2,
      maxConcurrent: 2,
      now: () => now,
      refillIntervalMs: 1_000,
    });

    limiter.begin()!();
    limiter.begin()!();
    expect(limiter.begin()).toBeUndefined();
    expect(limiter.retryAfterSeconds()).toBe(1);

    now = 1_999;
    expect(limiter.begin()).toBeUndefined();
    expect(limiter.retryAfterSeconds()).toBe(1);

    now = 2_000;
    limiter.begin()!();
    expect(limiter.begin()).toBeUndefined();

    now = 10_000;
    const first = limiter.begin();
    const second = limiter.begin();
    expect(first).toBeTypeOf('function');
    expect(second).toBeTypeOf('function');
    expect(limiter.begin()).toBeUndefined();
  });

  it('does not mint tokens when the clock moves backward', () => {
    let now = 1_000;
    const limiter = new VerificationAttemptLimiter({
      burst: 1,
      maxConcurrent: 1,
      now: () => now,
      refillIntervalMs: 1_000,
    });
    limiter.begin()!();

    now = 500;
    expect(limiter.begin()).toBeUndefined();
    now = 2_000;
    expect(limiter.begin()).toBeTypeOf('function');
  });

  it.each([
    ['burst', { burst: 0, maxConcurrent: 1, refillIntervalMs: 1_000 }],
    ['burst', { burst: 1.5, maxConcurrent: 1, refillIntervalMs: 1_000 }],
    ['maxConcurrent', { burst: 1, maxConcurrent: -1, refillIntervalMs: 1_000 }],
    [
      'maxConcurrent',
      {
        burst: 1,
        maxConcurrent: Number.MAX_SAFE_INTEGER + 1,
        refillIntervalMs: 1_000,
      },
    ],
    ['refillIntervalMs', { burst: 1, maxConcurrent: 1, refillIntervalMs: 0 }],
  ])('rejects invalid %s configuration', (name, options) => {
    expect(() => new VerificationAttemptLimiter(options)).toThrow(name);
  });

  it('accepts positive safe-integer limits', () => {
    expect(
      () =>
        new VerificationAttemptLimiter({
          burst: 12,
          maxConcurrent: 4,
          refillIntervalMs: 1_000,
        }),
    ).not.toThrow();
  });
});
