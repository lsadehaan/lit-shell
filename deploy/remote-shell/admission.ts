import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface AdmissionGrant {
  readonly expiresAt: number;
  readonly token: string;
}

export interface ActiveLease {
  readonly deadline: number;
  readonly id: number;
}

export class AdmissionUnavailableError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('The remote demo is currently busy');
    this.name = 'AdmissionUnavailableError';
    this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
  }
}

interface PendingLease {
  readonly digest: Buffer;
  readonly expiresAt: number;
  readonly id: number;
  readonly state: 'pending';
}

interface ConnectedLease {
  readonly deadline: number;
  readonly id: number;
  readonly state: 'active';
}

type Lease = ConnectedLease | PendingLease;

export interface AdmissionControllerOptions {
  readonly activeLeaseMs: number;
  readonly now?: () => number;
  readonly pendingLeaseMs: number;
  readonly tokenSource?: () => Buffer;
}

export class AdmissionController {
  private readonly activeLeaseMs: number;
  private readonly now: () => number;
  private readonly pendingLeaseMs: number;
  private readonly tokenSource: () => Buffer;
  private current: Lease | undefined;
  private nextLeaseId = 1;

  constructor(options: AdmissionControllerOptions) {
    this.activeLeaseMs = positiveInteger(
      options.activeLeaseMs,
      'activeLeaseMs',
    );
    this.pendingLeaseMs = positiveInteger(
      options.pendingLeaseMs,
      'pendingLeaseMs',
    );
    this.now = options.now ?? Date.now;
    this.tokenSource = options.tokenSource ?? (() => randomBytes(32));
  }

  issue(): AdmissionGrant {
    const now = this.now();
    this.expireCurrent(now);
    if (this.current) {
      throw new AdmissionUnavailableError(this.retryAfter(now));
    }

    const tokenBytes = this.tokenSource();
    if (tokenBytes.byteLength < 32) {
      throw new Error(
        'The admission token source returned fewer than 32 bytes',
      );
    }
    const token = tokenBytes.toString('base64url');
    const expiresAt = now + this.pendingLeaseMs;
    this.current = {
      digest: digestToken(token),
      expiresAt,
      id: this.nextLeaseId,
      state: 'pending',
    };
    this.nextLeaseId += 1;
    return { expiresAt, token };
  }

  consume(token: string): ActiveLease | undefined {
    const now = this.now();
    this.expireCurrent(now);
    const lease = this.current;
    if (!lease || lease.state !== 'pending') return undefined;

    const candidate = digestToken(token);
    if (!timingSafeEqual(candidate, lease.digest)) return undefined;

    const active = {
      deadline: now + this.activeLeaseMs,
      id: lease.id,
    };
    this.current = { ...active, state: 'active' };
    return active;
  }

  release(id: number): boolean {
    if (this.current?.id !== id) return false;
    this.current = undefined;
    return true;
  }

  status(): 'active' | 'available' | 'reserved' {
    this.expireCurrent(this.now());
    if (!this.current) return 'available';
    return this.current.state === 'active' ? 'active' : 'reserved';
  }

  private expireCurrent(now: number): void {
    const lease = this.current;
    if (
      (lease?.state === 'pending' && lease.expiresAt <= now) ||
      (lease?.state === 'active' && lease.deadline <= now)
    ) {
      this.current = undefined;
    }
  }

  private retryAfter(now: number): number {
    const lease = this.current;
    if (!lease) return 1;
    const end = lease.state === 'pending' ? lease.expiresAt : lease.deadline;
    return Math.ceil(Math.max(1, end - now) / 1000);
  }
}

function digestToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}
