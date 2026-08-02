import { createHash, timingSafeEqual } from 'node:crypto';

/** Compare an untrusted capability token without content-dependent equality. */
export function secureTokenMatches(
  supplied: string | undefined,
  expected: string,
): boolean {
  const suppliedDigest = digestToken(supplied ?? '');
  const expectedDigest = digestToken(expected);
  return (
    supplied !== undefined && timingSafeEqual(suppliedDigest, expectedDigest)
  );
}

function digestToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
