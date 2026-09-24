export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthCheckResult {
  readonly status: HealthStatus;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * A dependency probe (database, temporal, storage, AI providers…).
 * No checks are registered in PHASE 00; later phases add them without changing the endpoint.
 */
export interface HealthCheck {
  readonly name: string;
  /** A critical check that is down makes the whole service `down`; otherwise `degraded`. Default: true. */
  readonly critical?: boolean;
  /** Default: the registry's `defaultTimeoutMs`. */
  readonly timeoutMs?: number;
  check(): Promise<HealthCheckResult>;
}

export interface CheckReport extends HealthCheckResult {
  readonly duration_ms: number;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly service: string;
  /** Present only when at least one check is registered. */
  readonly checks?: Readonly<Record<string, CheckReport>>;
}

export interface HealthRegistry {
  register(check: HealthCheck): void;
  run(): Promise<HealthReport>;
}

export interface HealthRegistryOptions {
  readonly service: string;
  /** Default: 2 000 ms. */
  readonly defaultTimeoutMs?: number;
  /**
   * Receives the raw error of a failed or timed-out check (for logging).
   * Raw errors are never placed in the report, because the report may be publicly exposed.
   */
  readonly onCheckError?: (name: string, error: unknown) => void;
}

const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

class HealthCheckTimeoutError extends Error {
  override readonly name = 'HealthCheckTimeoutError';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new HealthCheckTimeoutError(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function aggregate(results: readonly (readonly [HealthCheck, CheckReport])[]): HealthStatus {
  let status: HealthStatus = 'ok';
  for (const [check, report] of results) {
    if (report.status === 'ok') continue;
    if (report.status === 'down' && (check.critical ?? true)) status = 'down';
    else if (status === 'ok') status = 'degraded';
  }
  return status;
}

export function createHealthRegistry(options: HealthRegistryOptions): HealthRegistry {
  const checks: HealthCheck[] = [];
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  async function runCheck(check: HealthCheck): Promise<CheckReport> {
    const startedAt = performance.now();
    const durationMs = (): number => Math.round(performance.now() - startedAt);
    try {
      const result = await withTimeout(check.check(), check.timeoutMs ?? defaultTimeoutMs);
      return { ...result, duration_ms: durationMs() };
    } catch (error) {
      options.onCheckError?.(check.name, error);
      const reason = error instanceof HealthCheckTimeoutError ? 'timeout' : 'check_failed';
      return { status: 'down', details: { error: reason }, duration_ms: durationMs() };
    }
  }

  return {
    register(check) {
      if (checks.some((existing) => existing.name === check.name)) {
        throw new Error(`Health check "${check.name}" is already registered`);
      }
      checks.push(check);
    },
    async run() {
      if (checks.length === 0) return { status: 'ok', service: options.service };

      const results = await Promise.all(
        checks.map(async (check) => [check, await runCheck(check)] as const),
      );
      return {
        status: aggregate(results),
        service: options.service,
        checks: Object.fromEntries(results.map(([check, report]) => [check.name, report])),
      };
    },
  };
}
