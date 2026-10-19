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
  /**
   * AI providers (PHASE 09, ADR-0006, D-021): optional; without a key its models are not used.
   * Secrets.
   */
  ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  /** Official APIs by default; tests point them to local fakes. */
  ANTHROPIC_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  OPENAI_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  GEMINI_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  /**
   * D-007: at most $50 a month, spread over the days left (D-021); the daily cap keeps a day's
   * cost entry under the $20 gate (D-006).
   */
  AI_MONTHLY_LIMIT_USD: z.coerce.number().positive().max(50).default(50),
  AI_DAILY_LIMIT_USD: z.coerce.number().positive().max(20).default(20),
  /** How often the pain analyst looks for new evidence (PHASE 06). Default: 15 minutes. */
  SIGNALS_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .default(15 * 60_000),
  /** How often models, evals and the daily cost are maintained. Default: one hour. */
  AI_MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(100).default(3_600_000),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function loadWorkerConfig(env: EnvSource): WorkerConfig {
  return loadConfig(workerConfigSchema, env);
}
