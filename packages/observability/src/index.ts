export {
  createLogger,
  isLogLevel,
  isSensitiveKey,
  LOG_LEVELS,
  serializeLogRecord,
  type LogFields,
  type Logger,
  type LoggerOptions,
  type LogLevel,
  type LogRecord,
  type LogSink,
} from './logger.js';
export {
  createHealthRegistry,
  type CheckReport,
  type HealthCheck,
  type HealthCheckResult,
  type HealthRegistry,
  type HealthRegistryOptions,
  type HealthReport,
  type HealthStatus,
} from './health.js';
export {
  CORRELATION_ID_HEADER,
  isValidCorrelationId,
  resolveCorrelationId,
} from './correlation.js';

export const PACKAGE_NAME = '@roi-dealer/observability';
