import { z } from 'zod';

export const nodeEnvSchema = z.enum(['development', 'test', 'production']);
export type NodeEnv = z.infer<typeof nodeEnvSchema>;

/** TCP port read from an environment string. `0` lets the OS pick a free port (used by tests). */
export const portSchema = z.coerce.number().int().min(0).max(65_535);

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface ConfigIssue {
  /** Environment variable (or nested path) that failed validation. */
  readonly key: string;
  readonly message: string;
}

/**
 * Thrown when environment configuration does not match its schema.
 * Only keys and validation messages are included — never the raw values,
 * because configuration may contain secrets.
 */
export class ConfigValidationError extends Error {
  override readonly name = 'ConfigValidationError';
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      `Invalid configuration: ${issues.map((issue) => `${issue.key} (${issue.message})`).join('; ')}`,
    );
    this.issues = issues;
  }
}

/**
 * Validates environment variables against a Zod schema.
 * Empty strings are treated as "not set" so that defaults apply to `KEY=` lines in `.env` files.
 */
export function loadConfig<TSchema extends z.ZodType>(
  schema: TSchema,
  env: EnvSource,
): z.output<TSchema> {
  const provided = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1].trim() !== '',
    ),
  );

  const result = schema.safeParse(provided);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => ({
        key: issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}
