import { AiTaskError } from '@roi-dealer/ai-runtime';
import type { AgentStop, AgentWorkOutcome, AgentWorkResult } from '@roi-dealer/database';
import type { Actor, NewPrincipal, Pain } from '@roi-dealer/domain';
import {
  collectEvidence,
  integrationActor,
  type EngineDeps,
  type SourceConnector,
} from '@roi-dealer/evidence';
import {
  activePrincipal,
  assertAgentsRunning,
  type AgentContext,
  type AgentDefinition,
  type AgentReport,
} from '../agent.js';
import { researchQueryTask, toSearchQuery } from './research-query.js';

/** The agent identity research runs as (PHASE 04): the owner grants it in /decisions. */
export const RESEARCHER: Actor = { type: 'agent', id: 'researcher' };

export const RESEARCHER_ACCESS: NewPrincipal = {
  actor: RESEARCHER,
  displayName: 'Агент исследований',
  purpose:
    'Для болей, у которых пока мало сигналов, подбирает с помощью AI короткий поисковый ' +
    'запрос и ищет похожие посты Ask HN через поиск Hacker News (HN Search API, Algolia): до 3 ' +
    'запросов за 6 часов. Посты сохраняет интеграция Hacker News с очисткой персональных данных. ' +
    'Решения, деньги и доступы не трогает. AI — в пределах 3 % дневной квоты.',
};

/** A pain with this many signals has enough evidence for the opportunity analyst. */
export const RESEARCH_MAX_SIGNALS = 3;
const DEFAULT_BATCH = 3;

export interface ResearcherOptions {
  /** A search connector of an allowed source (HN Search). */
  readonly search: SourceConnector;
  /** The AI pass of the evidence engine for names of people (PHASE 09). */
  readonly redactNames?: EngineDeps['redactNames'];
  /** Pains per run; default 3. */
  readonly batchSize?: number;
}

function stopOf(error: AiTaskError): AgentStop {
  return error.code === 'budget' || error.code === 'unavailable' ? error.code : 'failed';
}

/** Whether the owner has granted the source the search goes to. */
async function sourceGranted(context: AgentContext, catalogKey: string): Promise<boolean> {
  const source = await context.database.repositories.sources.getByCatalogKey(catalogKey);
  if (source?.status !== 'active') return false;
  return (
    (await activePrincipal(context.database, integrationActor({ key: catalogKey }))) !== undefined
  );
}

/**
 * The research agent (PHASE 10): for candidate pains with fewer than 3 signals, the AI proposes
 * a search query, code checks it, and the evidence engine loads matching posts from the source
 * (kill switch, catalog, the source's grant, redaction). The pain analyst then reads them. Each
 * pain version is researched once.
 */
export function researcherAgent(options: ResearcherOptions): AgentDefinition {
  const catalogKey = options.search.catalogKey;
  return {
    key: RESEARCHER.id,
    actor: RESEARCHER,
    access: RESEARCHER_ACCESS,
    tasks: [researchQueryTask],

    async run(context): Promise<AgentReport> {
      const { database, logger } = context;
      await assertAgentsRunning(database);
      if ((await activePrincipal(database, RESEARCHER)) === undefined) {
        return { outcome: 'no_access', processed: 0 };
      }
      if (!(await sourceGranted(context, catalogKey))) {
        logger.info('research skipped: the source is not granted', { catalog_key: catalogKey });
        return { outcome: 'no_access', processed: 0 };
      }
      const pains = await database.agentWork.pendingPains({
        agent: RESEARCHER.id,
        maxSignals: RESEARCH_MAX_SIGNALS,
        limit: options.batchSize ?? DEFAULT_BATCH,
      });
      if (pains.length === 0) return { outcome: 'idle', processed: 0 };

      let processed = 0;
      let found = 0;
      let stoppedBy: AgentStop | undefined;
      const record = async (
        pain: Pain,
        outcome: AgentWorkOutcome,
        correlationId: string,
        result: AgentWorkResult = {},
      ) => {
        await database.agentWork.record({
          agent: RESEARCHER.id,
          subjectType: 'pain',
          subjectId: pain.id,
          subjectVersion: pain.version,
          task: researchQueryTask.name,
          taskVersion: researchQueryTask.version,
          outcome,
          result,
          actorType: RESEARCHER.type,
          actorId: RESEARCHER.id,
          correlationId,
        });
        processed += 1;
      };

      for (const pain of pains) {
        if (context.signal.aborted) break;
        const correlationId = `research-${pain.id}-v${String(pain.version)}`;
        let query: string | undefined;
        try {
          const answer = await context.runtime.runTask(
            researchQueryTask,
            { title: pain.title, audience: pain.audience, desiredOutcome: pain.desiredOutcome },
            { actor: RESEARCHER, correlationId, signal: context.signal },
          );
          query = toSearchQuery(answer);
        } catch (error) {
          if (!(error instanceof AiTaskError)) throw error;
          if (error.code === 'invalid_input') {
            await record(pain, 'rejected', correlationId);
            continue;
          }
          if (error.code === 'failed') await record(pain, 'failed', correlationId);
          stoppedBy = stopOf(error);
          break;
        }
        if (query === undefined) {
          await record(pain, 'rejected', correlationId);
          continue;
        }

        const collected = await collectEvidence(options.search, {
          database,
          logger,
          now: context.now,
          redactNames: options.redactNames,
          signal: context.signal,
          query,
        });
        if (collected.status === 'skipped' && collected.reason !== 'nothing_new') {
          // The source lost its grant during the run: nothing is recorded, the pain waits.
          logger.info('research stopped: the source is not available', {
            reason: collected.reason,
          });
          break;
        }
        const evidence = collected.status === 'collected' ? collected.evidenceCount : 0;
        await record(
          pain,
          evidence === 0 ? 'empty' : 'done',
          correlationId,
          collected.status === 'collected'
            ? { query, evidence, snapshot: collected.snapshotId }
            : { query, evidence },
        );
        found += evidence;
      }

      logger.info('research', { researched: processed, evidence: found, stopped_by: stoppedBy });
      return { outcome: 'done', processed, stoppedBy };
    },
  };
}
