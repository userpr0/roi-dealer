import { z } from 'zod';
import { databaseConfigShape } from '@roi-dealer/database';
import { HACKER_NEWS_API_URL } from '@roi-dealer/evidence';
import { LOG_LEVELS } from '@roi-dealer/observability';
import { loadConfig, nodeEnvSchema, type EnvSource } from '@roi-dealer/shared';

const workerConfigSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(100).default(60_000),
  /** Optional: without it the worker only keeps its heartbeat (no evidence collection). */
  DATABASE_URL: databaseConfigShape.DATABASE_URL.optional(),
  DATABASE_POOL_MAX: databaseConfigShape.DATABASE_POOL_MAX,
  DATABASE_CONNECT_TIMEOUT_SECONDS: databaseConfigShape.DATABASE_CONNECT_TIMEOUT_SECONDS,
  /** How often the evidence scheduler wakes up; each source keeps its catalog interval. */
  EVIDENCE_COLLECT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .default(15 * 60_000),
  /** Official API by default; tests point it to a local fake. */
  HACKER_NEWS_API_URL: z.url({ protocol: /^https?$/ }).default(HACKER_NEWS_API_URL),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function loadWorkerConfig(env: EnvSource): WorkerConfig {
  return loadConfig(workerConfigSchema, env);
}
