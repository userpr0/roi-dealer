export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_SEVERITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export type LogFields = Readonly<Record<string, unknown>>;

/** One structured log entry. Serialized as a single JSON line. */
export interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly message: string;
  readonly correlation_id?: string;
  readonly [field: string]: unknown;
}

/** Receives one serialized JSON line (without trailing newline). */
export type LogSink = (line: string) => void;

export interface Logger {
  readonly service: string;
  readonly level: LogLevel;
  isLevelEnabled(level: LogLevel): boolean;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  fatal(message: string, fields?: LogFields): void;
  /** Returns a logger that adds `bindings` (e.g. `correlation_id`) to every record. */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  readonly service: string;
  /** Minimum level to emit. Default: `info`. */
  readonly level?: LogLevel;
  readonly bindings?: LogFields;
  /** Default: one JSON line per record to stdout. */
  readonly sink?: LogSink;
  readonly clock?: () => Date;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Set by the logger itself; fields cannot override them. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['timestamp', 'level', 'service', 'message']);

const REDACTED = '[REDACTED]';

/**
 * A key is sensitive when, lower-cased and stripped of `-` / `_`, it ends with one of these.
 * So `password`, `DB_PASSWORD`, `x-api-key`, `OPENAI_API_KEY` and `refreshToken` match,
 * while counters such as `token_count` or `max_tokens` do not.
 */
const SENSITIVE_KEY_SUFFIXES: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'privatekey',
  'databaseurl',
  'connectionstring',
];

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function serializeError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  };
}

/**
 * Serializes a record to one JSON line. Never throws:
 * redacts sensitive keys, expands `Error`s, stringifies `bigint`s and cuts repeated references.
 */
export function serializeLogRecord(record: LogRecord): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(record, (key: string, value: unknown) => {
      if (key !== '' && isSensitiveKey(key)) return REDACTED;
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Error) return serializeError(value);
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
  } catch {
    return JSON.stringify({
      timestamp: record.timestamp,
      level: record.level,
      service: record.service,
      message: record.message,
      ...(record.correlation_id === undefined ? {} : { correlation_id: record.correlation_id }),
      log_serialization_failed: true,
    });
  }
}

const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export function createLogger(options: LoggerOptions): Logger {
  const { service } = options;
  const level = options.level ?? 'info';
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? stdoutSink;
  const clock = options.clock ?? (() => new Date());
  const threshold = LEVEL_SEVERITY[level];

  const isLevelEnabled = (candidate: LogLevel): boolean => LEVEL_SEVERITY[candidate] >= threshold;

  const write = (recordLevel: LogLevel, message: string, fields: LogFields = {}): void => {
    if (!isLevelEnabled(recordLevel)) return;

    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({ ...bindings, ...fields })) {
      if (!RESERVED_KEYS.has(key) && value !== undefined) extra[key] = value;
    }

    const record: LogRecord = {
      timestamp: clock().toISOString(),
      level: recordLevel,
      service,
      message,
      ...extra,
    };

    try {
      sink(serializeLogRecord(record));
    } catch {
      // Logging must never crash the caller.
    }
  };

  return {
    service,
    level,
    isLevelEnabled,
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    fatal: (message, fields) => write('fatal', message, fields),
    child: (childBindings) =>
      createLogger({ ...options, bindings: { ...bindings, ...childBindings } }),
  };
}
