/** Largest delay Node.js timers can represent without overflowing to 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Default per-client WebSocket output queued before a slow client is dropped. */
export const DEFAULT_MAX_BUFFERED_OUTPUT_BYTES = 1024 * 1024;

/**
 * Terminal dimensions are untrusted protocol input. Keeping each axis bounded
 * protects both the native PTY and browser renderers from pathological sizes.
 */
export const MAX_TERMINAL_COLUMNS = 1_000;
export const MAX_TERMINAL_ROWS = 1_000;

export function isSafeIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum
  );
}

function assertSafeIntegerInRange(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (!isSafeIntegerInRange(value, minimum, maximum)) {
    throw new TypeError(
      `${name} must be a safe integer between ${minimum} and ${maximum}`,
    );
  }
}

export function resolveSafeIntegerOption(
  value: unknown,
  fallback: number,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const resolved = value ?? fallback;
  assertSafeIntegerInRange(resolved, name, minimum, maximum);
  return resolved;
}

export function resolveOptionalSafeIntegerOption(
  value: unknown,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined) return undefined;
  assertSafeIntegerInRange(value, name, minimum, maximum);
  return value;
}
