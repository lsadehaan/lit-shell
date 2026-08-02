import { describe, expect, it } from 'vitest';

import {
  AdmissionController,
  AdmissionUnavailableError,
} from '../../deploy/remote-shell/admission.js';

function sequentialTokenSource(): () => Buffer {
  let fill = 1;
  return () => Buffer.alloc(32, fill++);
}

describe('remote demo capacity-based admission controller', () => {
  it('fills every slot with a distinct opaque capability before refusing work', () => {
    let now = 1_000;
    const admissions = new AdmissionController({
      activeLeaseMs: 60_000,
      capacity: 3,
      now: () => now,
      pendingLeaseMs: 30_000,
      tokenSource: sequentialTokenSource(),
    });

    const first = admissions.issue();
    now = 2_000;
    const second = admissions.issue();
    now = 3_000;
    const third = admissions.issue();

    expect(new Set([first.token, second.token, third.token])).toHaveLength(3);
    expect(first).toMatchObject({ expiresAt: 31_000 });
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(admissions.snapshot()).toEqual({
      active: 0,
      capacity: 3,
      pending: 3,
    });
    expect(() => admissions.issue()).toThrow(AdmissionUnavailableError);
    try {
      admissions.issue();
    } catch (error) {
      expect(error).toMatchObject({
        message: 'The remote demo is currently busy',
        name: 'AdmissionUnavailableError',
        retryAfterSeconds: 28,
      });
    }
  });

  it('consumes each capability once without disturbing other slots', () => {
    let now = 5_000;
    const admissions = new AdmissionController({
      activeLeaseMs: 60_000,
      capacity: 2,
      now: () => now,
      pendingLeaseMs: 30_000,
      tokenSource: sequentialTokenSource(),
    });
    const first = admissions.issue();
    const second = admissions.issue();

    expect(admissions.consume('wrong-token')).toBeUndefined();
    expect(admissions.snapshot()).toEqual({
      active: 0,
      capacity: 2,
      pending: 2,
    });
    const secondLease = admissions.consume(second.token);
    expect(secondLease).toEqual({ deadline: 65_000, id: 2 });
    expect(admissions.consume(second.token)).toBeUndefined();
    expect(admissions.snapshot()).toEqual({
      active: 1,
      capacity: 2,
      pending: 1,
    });

    now = 6_000;
    expect(admissions.consume(first.token)).toEqual({
      deadline: 66_000,
      id: 1,
    });
    expect(admissions.snapshot()).toEqual({
      active: 2,
      capacity: 2,
      pending: 0,
    });
  });

  it('releases only the requested lease and immediately reuses its capacity', () => {
    const admissions = new AdmissionController({
      activeLeaseMs: 60_000,
      capacity: 2,
      pendingLeaseMs: 30_000,
      tokenSource: sequentialTokenSource(),
    });
    const firstLease = admissions.consume(admissions.issue().token)!;
    const secondLease = admissions.consume(admissions.issue().token)!;

    expect(admissions.release(99)).toBe(false);
    expect(admissions.release(firstLease.id)).toBe(true);
    expect(admissions.release(firstLease.id)).toBe(false);
    expect(admissions.snapshot()).toEqual({
      active: 1,
      capacity: 2,
      pending: 0,
    });
    expect(admissions.issue()).toMatchObject({ token: expect.any(String) });
    expect(admissions.release(secondLease.id)).toBe(true);
    expect(admissions.snapshot()).toEqual({
      active: 0,
      capacity: 2,
      pending: 1,
    });
  });

  it('expires pending and active slots independently at the exact deadline', () => {
    let now = 100;
    const admissions = new AdmissionController({
      activeLeaseMs: 1_000,
      capacity: 2,
      now: () => now,
      pendingLeaseMs: 50,
      tokenSource: sequentialTokenSource(),
    });
    const pending = admissions.issue();
    const activeGrant = admissions.issue();
    const active = admissions.consume(activeGrant.token)!;

    now = pending.expiresAt - 1;
    expect(admissions.snapshot()).toEqual({
      active: 1,
      capacity: 2,
      pending: 1,
    });
    now = pending.expiresAt;
    expect(admissions.snapshot()).toEqual({
      active: 1,
      capacity: 2,
      pending: 0,
    });
    expect(admissions.consume(pending.token)).toBeUndefined();

    now = active.deadline;
    expect(admissions.snapshot()).toEqual({
      active: 0,
      capacity: 2,
      pending: 0,
    });
    expect(admissions.release(active.id)).toBe(false);
  });

  it('computes retry-after from the earliest pending or active slot', () => {
    let now = 1_000;
    const admissions = new AdmissionController({
      activeLeaseMs: 20_000,
      capacity: 2,
      now: () => now,
      pendingLeaseMs: 10_000,
      tokenSource: sequentialTokenSource(),
    });
    const active = admissions.issue();
    expect(admissions.consume(active.token)).toBeDefined();
    now = 5_250;
    admissions.issue();

    expect(() => admissions.issue()).toThrow(
      expect.objectContaining({ retryAfterSeconds: 10 }),
    );
  });

  it('resets all leases while preserving monotonically increasing lease IDs', () => {
    const admissions = new AdmissionController({
      activeLeaseMs: 1_000,
      capacity: 2,
      pendingLeaseMs: 100,
      tokenSource: sequentialTokenSource(),
    });
    const stale = admissions.consume(admissions.issue().token)!;
    admissions.issue();

    admissions.reset();

    expect(admissions.snapshot()).toEqual({
      active: 0,
      capacity: 2,
      pending: 0,
    });
    expect(admissions.release(stale.id)).toBe(false);
    expect(admissions.consume(admissions.issue().token)).toMatchObject({
      id: 3,
    });
  });

  it.each([
    [{ activeLeaseMs: 0, capacity: 1, pendingLeaseMs: 1 }, 'activeLeaseMs'],
    [{ activeLeaseMs: 1, capacity: 0, pendingLeaseMs: 1 }, 'capacity'],
    [{ activeLeaseMs: 1, capacity: 1.5, pendingLeaseMs: 1 }, 'capacity'],
    [{ activeLeaseMs: 1, capacity: 1, pendingLeaseMs: 0 }, 'pendingLeaseMs'],
    [
      {
        activeLeaseMs: Number.MAX_SAFE_INTEGER + 1,
        capacity: 1,
        pendingLeaseMs: 1,
      },
      'activeLeaseMs',
    ],
  ])('rejects invalid options %#', (options, name) => {
    expect(() => new AdmissionController(options)).toThrow(name);
  });

  it('fails closed without reserving capacity when token entropy is insufficient', () => {
    let calls = 0;
    const admissions = new AdmissionController({
      activeLeaseMs: 1,
      capacity: 1,
      now: () => 0,
      pendingLeaseMs: 1,
      tokenSource: () => {
        calls += 1;
        return Buffer.alloc(calls === 1 ? 31 : 32, 7);
      },
    });

    expect(() => admissions.issue()).toThrow(/fewer than 32 bytes/u);
    expect(admissions.snapshot()).toEqual({
      active: 0,
      capacity: 1,
      pending: 0,
    });
    const grant = admissions.issue();
    expect(admissions.consume(grant.token)).toMatchObject({ id: 1 });
  });

  it('fails closed instead of issuing a duplicated capability', () => {
    const admissions = new AdmissionController({
      activeLeaseMs: 1_000,
      capacity: 2,
      pendingLeaseMs: 100,
      tokenSource: () => Buffer.alloc(32, 42),
    });
    const first = admissions.issue();

    expect(() => admissions.issue()).toThrow();
    expect(admissions.snapshot()).toEqual({
      active: 0,
      capacity: 2,
      pending: 1,
    });

    expect(admissions.consume(first.token)).toBeDefined();
    expect(admissions.consume(first.token)).toBeUndefined();
    expect(admissions.snapshot()).toEqual({
      active: 1,
      capacity: 2,
      pending: 0,
    });
  });

  it('keeps active capability digests reserved until the lease ends', () => {
    const admissions = new AdmissionController({
      activeLeaseMs: 1_000,
      capacity: 2,
      pendingLeaseMs: 100,
      tokenSource: () => Buffer.alloc(32, 42),
    });
    const active = admissions.consume(admissions.issue().token);

    expect(active).toBeDefined();
    expect(() => admissions.issue()).toThrow(/duplicate token/u);
    expect(admissions.snapshot()).toEqual({
      active: 1,
      capacity: 2,
      pending: 0,
    });
  });
});
