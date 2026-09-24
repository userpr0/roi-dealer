import { randomUUID } from 'node:crypto';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Restricts client-supplied ids to a safe charset and length to prevent log injection. */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidCorrelationId(value: string): boolean {
  return CORRELATION_ID_PATTERN.test(value);
}

/**
 * Returns the incoming correlation id if it is well-formed, otherwise a new UUID.
 * Accepts a raw header value as provided by `node:http` (`string | string[] | undefined`).
 */
export function resolveCorrelationId(
  incoming: string | readonly string[] | undefined,
  generate: () => string = randomUUID,
): string {
  const candidate = typeof incoming === 'string' ? incoming : incoming?.[0];
  return candidate !== undefined && isValidCorrelationId(candidate) ? candidate : generate();
}
