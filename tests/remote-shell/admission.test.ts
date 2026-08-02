import { describe, expect, it } from 'vitest';

import {
  AdmissionController,
  AdmissionUnavailableError,
} from '../../deploy/remote-shell/admission.js';

describe('remote demo anonymous admission controller', () => {
  it('issues one opaque capability and refuses a second reservation', () => {
    let now = 1_000;
    const admissions = new AdmissionController({
      activeLeaseMs: 60_000,
      now: () => now,
      pendingLeaseMs: 30_000,
      tokenSource: () => Buffer.alloc(32, 7),
    });

    const grant = admissions.issue();
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(grant.expiresAt).toBe(31_000);
    expect(admissions.status()).toBe('reserved');
    expect(() => admissions.issue()).toThrow(AdmissionUnavailableError);
    try {
      admissions.issue();
    } catch (error) {
      expect(error).toMatchObject({ retryAfterSeconds: 30 });
    }

    now += 1;
    expect(admissions.status()).toBe('reserved');
  });

  it('consumes the capability once and releases only the matching lease', () => {
    let now = 5_000;
    const admissions = new AdmissionController({
      activeLeaseMs: 60_000,
      now: () => now,
      pendingLeaseMs: 30_000,
      tokenSource: () => Buffer.alloc(32, 11),
    });
    const grant = admissions.issue();

    expect(admissions.consume('wrong-token')).toBeUndefined();
    const lease = admissions.consume(grant.token);
    expect(lease).toEqual({ deadline: 65_000, id: 1 });
    expect(admissions.consume(grant.token)).toBeUndefined();
    expect(admissions.status()).toBe('active');
    expect(admissions.release(2)).toBe(false);
    expect(admissions.status()).toBe('active');

    now = lease!.deadline;
    expect(admissions.status()).toBe('available');
    expect(admissions.release(lease!.id)).toBe(false);
    expect(admissions.issue().token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('expires unused reservations and never accepts their old token', () => {
    let now = 100;
    let fill = 1;
    const admissions = new AdmissionController({
      activeLeaseMs: 1_000,
      now: () => now,
      pendingLeaseMs: 50,
      tokenSource: () => Buffer.alloc(32, fill++),
    });
    const expired = admissions.issue();

    now = expired.expiresAt;
    expect(admissions.status()).toBe('available');
    expect(admissions.consume(expired.token)).toBeUndefined();
    const replacement = admissions.issue();
    expect(replacement.token).not.toBe(expired.token);
  });

  it.each([
    [{ activeLeaseMs: 0, pendingLeaseMs: 1 }, 'activeLeaseMs'],
    [{ activeLeaseMs: 1, pendingLeaseMs: 0 }, 'pendingLeaseMs'],
  ])('rejects invalid timing options', (options, name) => {
    expect(() => new AdmissionController(options)).toThrow(name);
  });

  it('fails closed when a token source provides insufficient entropy', () => {
    const admissions = new AdmissionController({
      activeLeaseMs: 1,
      pendingLeaseMs: 1,
      tokenSource: () => Buffer.alloc(31),
    });

    expect(() => admissions.issue()).toThrow(/fewer than 32 bytes/);
    expect(admissions.status()).toBe('available');
  });
});
