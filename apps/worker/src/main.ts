import { createLeadRetention } from '@roi-dealer/crm';
import {
  AGENT_TASKS,
  createAgentScheduler,
  hypothesisDesignerAgent,
  landingWriterAgent,
  marketAnalystAgent,
  opportunityAnalystAgent,
  painAnalystAgent,
  researcherAgent,
} from '@roi-dealer/agents';
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
import { JUDGE_TASKS, judgesAgent } from '@roi-dealer/judges';
import { createDatabase, createServiceHeartbeat } from '@roi-dealer/database';
import { createSpendGuard } from '@roi-dealer/economics';
import {
  createEvidenceScheduler,
  createHackerNewsConnector,
  createHackerNewsSearchConnector,
  EVIDENCE_ENGINE_ACTOR,
} from '@roi-dealer/evidence';
import { MEDIA_TASKS } from '@roi-dealer/media';
import { createLogger } from '@roi-dealer/observability';
import {
  createShutdownManager,
  exitProcess,
  installProcessHandlers,
  serviceVersion,
} from '@roi-dealer/shared';
import { OPPORTUNITY_TASKS } from '@roi-dealer/opportunities';
import { SIGNAL_TASKS } from '@roi-dealer/signals';
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
      createGoogleProvider({
        apiKey: config.GEMINI_API_KEY,
        freeApiKey: config.GEMINIFREE_API_KEY,
        baseUrl: config.GEMINI_BASE_URL,
      }),
    );
  } else if (config.GEMINIFREE_API_KEY !== undefined) {
    logger.warn('GEMINIFREE_API_KEY is used only together with GEMINI_API_KEY');
  }
  // The free Gemini quota (D-025): simple tasks try it first.
  const freeTier =
    config.GEMINI_API_KEY !== undefined && config.GEMINIFREE_API_KEY !== undefined
      ? ['google']
      : [];
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
    free_tier: freeTier,
  });
  const maintenance = createAiMaintenance({
    runtime: ai,
    database,
    logger,
    tasks: [
      ...AI_TASKS,
      ...SIGNAL_TASKS,
      ...OPPORTUNITY_TASKS,
      ...AGENT_TASKS,
      ...JUDGE_TASKS,
      ...MEDIA_TASKS,
    ],
    intervalMs: config.AI_MAINTENANCE_INTERVAL_MS,
  });

  const namesPass =
    providers.length === 0
      ? undefined
      : (text: string) => redactNames(ai, text, { actor: EVIDENCE_ENGINE_ACTOR });
  const evidence = createEvidenceScheduler({
    database,
    logger,
    connectors: [createHackerNewsConnector({ baseUrl: config.HACKER_NEWS_API_URL })],
    ensureAccess: ensureAccessRequest,
    intervalMs: config.EVIDENCE_COLLECT_INTERVAL_MS,
    redactNames: namesPass,
  });
  // The agents (PHASE 06, 07, 10, 11, 14) need AI: without a provider they do not even ask for access.
  const agents = createAgentScheduler({
    database,
    logger,
    runtime: ai,
    ensureAccess: ensureAccessRequest,
    agents:
      providers.length === 0
        ? []
        : [
            { agent: painAnalystAgent(), intervalMs: config.SIGNALS_INTERVAL_MS },
            { agent: opportunityAnalystAgent(), intervalMs: config.OPPORTUNITIES_INTERVAL_MS },
            {
              agent: researcherAgent({
                search: createHackerNewsSearchConnector({
                  baseUrl: config.HACKER_NEWS_SEARCH_URL,
                }),
                redactNames: namesPass,
              }),
              intervalMs: config.RESEARCH_INTERVAL_MS,
            },
            { agent: marketAnalystAgent(), intervalMs: config.MARKET_INTERVAL_MS },
            { agent: judgesAgent(), intervalMs: config.JUDGES_INTERVAL_MS },
            { agent: hypothesisDesignerAgent(), intervalMs: config.HYPOTHESES_INTERVAL_MS },
            { agent: landingWriterAgent(), intervalMs: config.LANDING_INTERVAL_MS },
          ],
  });
  // The spend guard (PHASE 16) pauses automation when it spends twice its usual (D-014 п.10).
  const spendGuard = createSpendGuard({
    database,
    logger,
    intervalMs: config.SPEND_GUARD_INTERVAL_MS,
  });
  // The retention period (PHASE 20): emails of leads that did not become customers.
  const retention = createLeadRetention({
    database,
    logger,
    intervalMs: config.LEAD_RETENTION_INTERVAL_MS,
  });
  // The bot's watchdog (13c): the worker marks that it runs and which AI providers it has.
  const heartbeat = createServiceHeartbeat({
    watch: database.services,
    service: SERVICE,
    version: serviceVersion(config),
    setup: { ai: providers.map((provider) => provider.provider), ai_free: freeTier },
    logger,
    intervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
  });
  heartbeat.start();
  maintenance.start();
  evidence.start();
  agents.start();
  spendGuard.start();
  retention.start();
  // Registered last, so they stop first: work finishes before the database closes.
  shutdown.register('ai-maintenance', () => maintenance.stop());
  shutdown.register('evidence-collection', () => evidence.stop());
  shutdown.register('agents', () => agents.stop());
  shutdown.register('spend-guard', () => spendGuard.stop());
  shutdown.register('lead-retention', () => retention.stop());
  shutdown.register('heartbeat', () => heartbeat.stop());
}

try {
  main();
} catch (error) {
  createLogger({ service: SERVICE }).fatal('worker failed to start', { error });
  exitProcess(1);
}
