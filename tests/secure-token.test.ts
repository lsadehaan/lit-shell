import { describe, expect, it } from 'vitest';

import { secureTokenMatches } from '../src/server/secure-token.js';

describe('secureTokenMatches', () => {
  const token = '70021513-167b-4f20-b947-a87167e29ed3';

  it('accepts only the exact capability token', () => {
    expect(secureTokenMatches(token, token)).toBe(true);
    expect(secureTokenMatches(`${token}x`, token)).toBe(false);
    expect(secureTokenMatches(token.slice(0, -1), token)).toBe(false);
    expect(
      secureTokenMatches('70021513-167b-4f20-b947-a87167e29ed2', token),
    ).toBe(false);
  });

  it('rejects a missing token after comparing fixed-length digests', () => {
    expect(secureTokenMatches(undefined, token)).toBe(false);
  });

  it('handles untrusted Unicode and arbitrary lengths safely', () => {
    expect(secureTokenMatches('🔐'.repeat(10_000), token)).toBe(false);
  });
});
