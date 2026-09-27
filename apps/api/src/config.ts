import { z } from 'zod';
import { databaseConfigShape } from '@roi-dealer/database';
import { LOG_LEVELS } from '@roi-dealer/observability';
import { loadConfig, nodeEnvSchema, portSchema, type EnvSource } from '@roi-dealer/shared';

const apiConfigSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Loopback by default; bind to 0.0.0.0 explicitly when running inside a container. */
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: portSchema.default(3000),
  /** Optional until the first API endpoint needs data: when set, `/health` checks the database. */
  DATABASE_URL: databaseConfigShape.DATABASE_URL.optional(),
  DATABASE_POOL_MAX: databaseConfigShape.DATABASE_POOL_MAX,
  DATABASE_CONNECT_TIMEOUT_SECONDS: databaseConfigShape.DATABASE_CONNECT_TIMEOUT_SECONDS,
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export function loadApiConfig(env: EnvSource): ApiConfig {
  return loadConfig(apiConfigSchema, env);
}
