import {
  AI_TASKS,
  createAiMaintenance,
  createAiRuntime,
  createAnthropicProvider,
  createGoogleProvider,
  createOpenAiProvider,
  redactNames,
  type AiProviderClient,
} from '@roi-dealer/ai-runtime';
import { ensureAccessRequest } from '@roi-dealer/command-center';
import { createDatabase } from '@roi-dealer/database';
import {
  createEvidenceScheduler,
  createHackerNewsConnector,
  EVIDENCE_ENGINE_ACTOR,
} from '@roi-dealer/evidence';
import { createLogger } from '@roi-dealer/observability';
import { createShutdownManager, exitProcess, installProcessHandlers } from '@roi-dealer/shared';
import { loadWorkerConfig } from './config.js';
import { createWorker } from './worker.js';

const SERVICE = 'worker';
const USD = 1_000_000;

function main(): void {
  const config = loadWorkerConfig(process.env);
  const logger = createLogger({ service: SERVICE, level: config.LOG_LEVEL });

  const shutdown = createShutdownManager({ logger });
  installProcessHandlers(shutdown, { logger });

  const worker = createWorker({ logger, heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS });
  worker.start();
  shutdown.register('worker', () => worker.stop());

  // Evidence collection (PHASE 05) needs PostgreSQL: the catalog, grants and evidence live there.
  if (config.DATABASE_URL === undefined) {
    logger.info('database not configured: evidence collection is off');
    return;
  }
  const database = createDatabase({
    url: config.DATABASE_URL,
    applicationName: 'roi-dealer-worker',
    maxConnections: config.DATABASE_POOL_MAX,
    connectTimeoutSeconds: config.DATABASE_CONNECT_TIMEOUT_SECONDS,
    logger,
  });
  shutdown.register('database', () => database.close());

  // AI (PHASE 09): only providers with a key; without any, tasks are unavailable and evidence is
  // redacted by rules only.
  const providers: AiProviderClient[] = [];
  if (config.ANTHROPIC_API_KEY !== undefined) {
    providers.push(
      createAnthropicProvider({
        apiKey: config.ANTHROPIC_API_KEY,
        baseUrl: config.ANTHROPIC_BASE_URL,
      }),
    );
  }
  if (config.OPENAI_API_KEY !== undefined) {
    providers.push(
      createOpenAiProvider({ apiKey: config.OPENAI_API_KEY, baseUrl: config.OPENAI_BASE_URL }),
    );
  }
  if (config.GEMINI_API_KEY !== undefined) {
    providers.push(
      createGoogleProvider({ apiKey: config.GEMINI_API_KEY, baseUrl: config.GEMINI_BASE_URL }),
    );
  }
  const ai = createAiRuntime({
    database,
    logger,
    providers,
    limits: {
      monthlyMicroUsd: Math.round(config.AI_MONTHLY_LIMIT_USD * USD),
      dailyCapMicroUsd: Math.round(config.AI_DAILY_LIMIT_USD * USD),
    },
  });
  logger.info('ai providers configured', {
    providers: providers.map((provider) => provider.provider),
  });
  const maintenance = createAiMaintenance({
    runtime: ai,
    database,
    logger,
    tasks: AI_TASKS,
    intervalMs: config.AI_MAINTENANCE_INTERVAL_MS,
  });

  const evidence = createEvidenceScheduler({
    database,
    logger,
    connectors: [createHackerNewsConnector({ baseUrl: config.HACKER_NEWS_API_URL })],
    ensureAccess: ensureAccessRequest,
    intervalMs: config.EVIDENCE_COLLECT_INTERVAL_MS,
    redactNames:
      providers.length === 0
        ? undefined
        : (text) => redactNames(ai, text, { actor: EVIDENCE_ENGINE_ACTOR }),
  });
  maintenance.start();
  evidence.start();
  // Registered last, so they stop first: work finishes before the database closes.
  shutdown.register('ai-maintenance', () => maintenance.stop());
  shutdown.register('evidence-collection', () => evidence.stop());
}

try {
  main();
} catch (error) {
  createLogger({ service: SERVICE }).fatal('worker failed to start', { error });
  exitProcess(1);
}
