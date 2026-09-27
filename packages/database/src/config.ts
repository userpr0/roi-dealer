import { z } from 'zod';
import { loadConfig, type EnvSource } from '@roi-dealer/shared';

/** `postgres://` or `postgresql://` URL. Contains the password: never log it. */
export const databaseUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });

/** Connection settings shared by every process that talks to PostgreSQL. */
export const databaseConfigShape = {
  DATABASE_URL: databaseUrlSchema,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  DATABASE_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(60).default(10),
};

export const databaseConfigSchema = z.object(databaseConfigShape);
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

export function loadDatabaseConfig(env: EnvSource): DatabaseConfig {
  return loadConfig(databaseConfigSchema, env);
}
