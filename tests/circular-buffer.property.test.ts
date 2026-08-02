import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { CircularBuffer } from '../src/server/circular-buffer.js';

describe('CircularBuffer invariants', () => {
  it('always retains the exact suffix that fits its capacity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 256 }),
        fc.array(fc.string({ maxLength: 128 }), { maxLength: 80 }),
        (capacity, chunks) => {
          const buffer = new CircularBuffer(capacity);
          for (const chunk of chunks) buffer.append(chunk);

          const complete = chunks.join('');
          const expected = capacity === 0 ? '' : complete.slice(-capacity);
          expect(buffer.toString()).toBe(expected);
          expect(buffer.size()).toBe(expected.length);
          expect(buffer.size()).toBeLessThanOrEqual(buffer.capacity());
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it('tail never returns more than requested', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 1_024 }),
        fc.integer({ min: 0, max: 1_024 }),
        (value, limit) => {
          const buffer = new CircularBuffer(1_024);
          buffer.append(value);
          expect(buffer.tail(limit)).toBe(
            limit === 0 ? '' : value.slice(-limit),
          );
        },
      ),
    );
  });
});
