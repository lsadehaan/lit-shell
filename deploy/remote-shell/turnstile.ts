import { randomUUID } from 'node:crypto';

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_TOKEN_LIFETIME_MS = 300_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

export class TurnstileUnavailableError extends Error {
  constructor(message = 'Human verification is temporarily unavailable') {
    super(message);
    this.name = 'TurnstileUnavailableError';
  }
}

export interface TurnstileVerifier {
  verify(token: string): Promise<boolean>;
}

interface TurnstileVerifierOptions {
  readonly expectedAction?: string;
  readonly expectedHostname: string;
  readonly fetch?: typeof fetch;
  readonly idempotencyKeySource?: () => string;
  readonly now?: () => number;
  readonly secretKey: string;
  readonly timeoutMs?: number;
}

interface SiteverifyResponse {
  readonly action?: unknown;
  readonly challenge_ts?: unknown;
  readonly 'error-codes'?: unknown;
  readonly hostname?: unknown;
  readonly success?: unknown;
}

export function createTurnstileVerifier(
  options: TurnstileVerifierOptions,
): TurnstileVerifier {
  const fetchImplementation = options.fetch ?? fetch;
  const idempotencyKeySource = options.idempotencyKeySource ?? randomUUID;
  const now = options.now ?? Date.now;
  const timeoutMs = positiveInteger(options.timeoutMs ?? 2_000, 'timeoutMs');
  if (!options.secretKey) throw new TypeError('secretKey is required');
  if (!options.expectedHostname) {
    throw new TypeError('expectedHostname is required');
  }

  return {
    async verify(token: string): Promise<boolean> {
      if (token.length < 1 || token.length > 2_048) return false;
      const idempotencyKey = idempotencyKeySource();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await verifyOnce({
          expectedAction: options.expectedAction,
          expectedHostname: options.expectedHostname,
          fetchImplementation,
          idempotencyKey,
          now,
          secretKey: options.secretKey,
          timeoutMs,
          token,
        });
        if (result === 'retry' && attempt === 0) continue;
        if (result === 'retry') throw new TurnstileUnavailableError();
        return result === 'valid';
      }
      throw new TurnstileUnavailableError();
    },
  };
}

interface VerifyOnceOptions {
  readonly expectedAction?: string;
  readonly expectedHostname: string;
  readonly fetchImplementation: typeof fetch;
  readonly idempotencyKey: string;
  readonly now: () => number;
  readonly secretKey: string;
  readonly timeoutMs: number;
  readonly token: string;
}

async function verifyOnce(
  options: VerifyOnceOptions,
): Promise<'invalid' | 'retry' | 'valid'> {
  const body = new URLSearchParams({
    idempotency_key: options.idempotencyKey,
    response: options.token,
    secret: options.secretKey,
  });
  let response: Response;
  try {
    response = await options.fetchImplementation(SITEVERIFY_URL, {
      body,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    return 'retry';
  }

  if (response.status >= 500 || response.status === 429) return 'retry';
  if (!response.ok) throw new TurnstileUnavailableError();
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new TurnstileUnavailableError();
  }

  let value: SiteverifyResponse;
  try {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new TurnstileUnavailableError();
    }
    value = JSON.parse(text) as SiteverifyResponse;
  } catch (error) {
    if (error instanceof TurnstileUnavailableError) throw error;
    throw new TurnstileUnavailableError();
  }

  if (value.success !== true) {
    return hasErrorCode(value, 'internal-error') ? 'retry' : 'invalid';
  }
  if (
    value.hostname !== options.expectedHostname ||
    (options.expectedAction !== undefined &&
      value.action !== options.expectedAction) ||
    typeof value.challenge_ts !== 'string'
  ) {
    return 'invalid';
  }
  const challengedAt = Date.parse(value.challenge_ts);
  const age = options.now() - challengedAt;
  if (
    !Number.isFinite(challengedAt) ||
    age < -MAX_CLOCK_SKEW_MS ||
    age > TURNSTILE_TOKEN_LIFETIME_MS
  ) {
    return 'invalid';
  }
  return 'valid';
}

function hasErrorCode(value: SiteverifyResponse, expected: string): boolean {
  return (
    Array.isArray(value['error-codes']) &&
    value['error-codes'].some((code) => code === expected)
  );
}

interface VerificationAttemptLimiterOptions {
  readonly burst: number;
  readonly maxConcurrent: number;
  readonly now?: () => number;
  readonly refillIntervalMs: number;
}

export class VerificationAttemptLimiter {
  private active = 0;
  private available: number;
  private lastRefillAt: number;
  private readonly now: () => number;

  constructor(private readonly options: VerificationAttemptLimiterOptions) {
    positiveInteger(options.burst, 'burst');
    positiveInteger(options.maxConcurrent, 'maxConcurrent');
    positiveInteger(options.refillIntervalMs, 'refillIntervalMs');
    this.available = options.burst;
    this.now = options.now ?? Date.now;
    this.lastRefillAt = this.now();
  }

  begin(): (() => void) | undefined {
    this.refill(this.now());
    if (this.active >= this.options.maxConcurrent || this.available < 1) {
      return undefined;
    }

    this.active += 1;
    this.available -= 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }

  retryAfterSeconds(): number {
    const now = this.now();
    this.refill(now);
    if (this.available >= 1) return 1;
    const elapsed = Math.max(0, now - this.lastRefillAt);
    return Math.max(
      1,
      Math.ceil((this.options.refillIntervalMs - elapsed) / 1_000),
    );
  }

  private refill(now: number): void {
    const intervals = Math.floor(
      Math.max(0, now - this.lastRefillAt) / this.options.refillIntervalMs,
    );
    if (intervals < 1) return;
    this.available = Math.min(this.options.burst, this.available + intervals);
    this.lastRefillAt += intervals * this.options.refillIntervalMs;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}
