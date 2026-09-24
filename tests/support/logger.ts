import { createLogger, type Logger, type LogLevel } from '@roi-dealer/observability';

export type CapturedRecord = Record<string, unknown>;

/** Logger that keeps parsed JSON records in memory instead of writing to stdout. */
export function createCapturingLogger(
  service = 'test',
  level: LogLevel = 'debug',
): { logger: Logger; records: CapturedRecord[] } {
  const records: CapturedRecord[] = [];
  const logger = createLogger({
    service,
    level,
    sink: (line) => records.push(JSON.parse(line) as CapturedRecord),
  });
  return { logger, records };
}
