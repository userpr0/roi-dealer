import { createHash, randomBytes } from 'node:crypto';

/*
 * Limits of the sign-up form (PHASE 20): a few submissions per visitor an hour and a cap per
 * minute for the process. Visitors are salted hashes in memory, never stored or logged.
 */

export interface SubmissionLimiter {
  /** Whether this visitor may submit now; a granted submission counts. */
  allow(address: string | undefined): boolean;
}

export interface SubmissionLimits {
  readonly perVisitorPerHour?: number;
  readonly perMinute?: number;
  readonly now?: () => number;
}

const HOUR_MS = 3_600_000;
const MAX_VISITORS = 20_000;

export function createSubmissionLimiter(limits: SubmissionLimits = {}): SubmissionLimiter {
  const perVisitor = limits.perVisitorPerHour ?? 5;
  const perMinute = limits.perMinute ?? 60;
  const now = limits.now ?? Date.now;
  const salt = randomBytes(16);
  const visitors = new Map<string, number[]>();
  let minute = { startMs: 0, count: 0 };

  return {
    allow(address) {
      const atMs = now();
      if (atMs - minute.startMs >= 60_000) minute = { startMs: atMs, count: 0 };
      if (minute.count >= perMinute) return false;
      const key = createHash('sha256')
        .update(salt)
        .update(address ?? '')
        .digest('base64url');
      const recent = (visitors.get(key) ?? []).filter((time) => atMs - time < HOUR_MS);
      if (recent.length >= perVisitor) return false;
      if (!visitors.has(key) && visitors.size >= MAX_VISITORS) {
        const oldest = visitors.keys().next().value;
        if (oldest !== undefined) visitors.delete(oldest);
      }
      visitors.set(key, [...recent, atMs]);
      minute = { ...minute, count: minute.count + 1 };
      return true;
    },
  };
}
