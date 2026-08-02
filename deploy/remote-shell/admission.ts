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
  readonly digest: Buffer;
  readonly id: number;
  readonly state: 'active';
}

type Lease = ConnectedLease | PendingLease;

export interface AdmissionControllerOptions {
  readonly activeLeaseMs: number;
  readonly capacity: number;
  readonly now?: () => number;
  readonly pendingLeaseMs: number;
  readonly tokenSource?: () => Buffer;
}

export interface AdmissionSnapshot {
  readonly active: number;
  readonly capacity: number;
  readonly pending: number;
}

export class AdmissionController {
  private readonly activeLeaseMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly pendingLeaseMs: number;
  private readonly tokenSource: () => Buffer;
  private readonly leases = new Map<number, Lease>();
  private nextLeaseId = 1;

  constructor(options: AdmissionControllerOptions) {
    this.activeLeaseMs = positiveInteger(
      options.activeLeaseMs,
      'activeLeaseMs',
    );
    this.capacity = positiveInteger(options.capacity, 'capacity');
    this.pendingLeaseMs = positiveInteger(
      options.pendingLeaseMs,
      'pendingLeaseMs',
    );
    this.now = options.now ?? Date.now;
    this.tokenSource = options.tokenSource ?? (() => randomBytes(32));
  }

  issue(): AdmissionGrant {
    const now = this.now();
    this.expireLeases(now);
    if (this.leases.size >= this.capacity) {
      throw new AdmissionUnavailableError(this.retryAfter(now));
    }

    const tokenBytes = this.tokenSource();
    if (tokenBytes.byteLength < 32) {
      throw new Error(
        'The admission token source returned fewer than 32 bytes',
      );
    }
    const token = tokenBytes.toString('base64url');
    const digest = digestToken(token);
    if (
      Array.from(this.leases.values()).some((lease) =>
        timingSafeEqual(digest, lease.digest),
      )
    ) {
      throw new Error('The admission token source returned a duplicate token');
    }
    const expiresAt = now + this.pendingLeaseMs;
    this.leases.set(this.nextLeaseId, {
      digest,
      expiresAt,
      id: this.nextLeaseId,
      state: 'pending',
    });
    this.nextLeaseId += 1;
    return { expiresAt, token };
  }

  consume(token: string): ActiveLease | undefined {
    const now = this.now();
    this.expireLeases(now);
    const candidate = digestToken(token);
    const lease = Array.from(this.leases.values()).find(
      (entry) =>
        entry.state === 'pending' && timingSafeEqual(candidate, entry.digest),
    );
    if (!lease || lease.state !== 'pending') return undefined;

    const active = {
      deadline: now + this.activeLeaseMs,
      id: lease.id,
    };
    this.leases.set(lease.id, {
      ...active,
      digest: lease.digest,
      state: 'active',
    });
    return active;
  }

  release(id: number): boolean {
    return this.leases.delete(id);
  }

  reset(): void {
    this.leases.clear();
  }

  snapshot(): AdmissionSnapshot {
    this.expireLeases(this.now());
    let active = 0;
    let pending = 0;
    for (const lease of this.leases.values()) {
      if (lease.state === 'active') active += 1;
      else pending += 1;
    }
    return { active, capacity: this.capacity, pending };
  }

  private expireLeases(now: number): void {
    for (const [id, lease] of this.leases) {
      if (
        (lease.state === 'pending' && lease.expiresAt <= now) ||
        (lease.state === 'active' && lease.deadline <= now)
      ) {
        this.leases.delete(id);
      }
    }
  }

  private retryAfter(now: number): number {
    const deadlines = Array.from(this.leases.values(), (lease) =>
      lease.state === 'pending' ? lease.expiresAt : lease.deadline,
    );
    return Math.ceil(Math.max(1, Math.min(...deadlines) - now) / 1000);
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
