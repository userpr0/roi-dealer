import { AiTaskError } from '@roi-dealer/ai-runtime';
import type { AgentStop, AgentWorkOutcome, AgentWorkResult } from '@roi-dealer/database';
import {
  createKnowledgeAsset,
  knowledgeAssetIdSchema,
  MARKET_CONTEXT_TAG,
  marketContextSchema,
  timestampMs,
  toTimestamp,
  type Actor,
  type Evidence,
  type EvidenceId,
  type MarketContextData,
  type NewPrincipal,
  type Opportunity,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import {
  activePrincipal,
  assertAgentsRunning,
  type AgentContext,
  type AgentDefinition,
  type AgentReport,
} from '../agent.js';
import {
  isEmptyContext,
  marketContextTask,
  marketSummary,
  MAX_MARKET_EXCERPTS,
  toMarketContext,
  type MarketContext,
} from './market-context.js';

/** The agent identity market context runs as (PHASE 04): the owner grants it in /decisions. */
export const MARKET_ANALYST: Actor = { type: 'agent', id: 'market-analyst' };

export const MARKET_ANALYST_ACCESS: NewPrincipal = {
  actor: MARKET_ANALYST,
  displayName: 'Агент рыночного контекста',
  purpose:
    'Для черновиков возможностей собирает из доказательств, чем люди решают проблему сейчас, ' +
    'какие суммы называют и кто платит. Сохраняет только пункты с цитатой, которая есть в ' +
    'доказательстве; суммы берёт из цитат; размеры рынка и конкурентов не придумывает. Пишет ' +
    'знание в Company Brain; решения, деньги и доступы не трогает. AI — в пределах 7 % ' +
    'дневной квоты.',
};

const OWN_EXCERPTS = 8;
const DEFAULT_BATCH = 3;
const EXCERPT_LENGTH = 1_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function stopOf(error: AiTaskError): AgentStop {
  return error.code === 'budget' || error.code === 'unavailable' ? error.code : 'failed';
}

/** The opportunity's own evidence (newest first), then similar evidence from the Brain. */
async function materialFor(context: AgentContext, opportunity: Opportunity): Promise<Evidence[]> {
  const { repositories, brain } = context.database;
  const pains = await repositories.pains.getByIds(opportunity.painIds);
  const ownIds = [...new Set(pains.flatMap((pain) => pain.evidenceIds))];
  const own = [...(await repositories.evidence.getByIds(ownIds))]
    .sort((a, b) => timestampMs(b.observedAt) - timestampMs(a.observedAt))
    .slice(0, OWN_EXCERPTS);
  const hits = await brain.search(`${opportunity.title} ${opportunity.icp}`, {
    mode: 'any',
    types: ['evidence'],
    limit: MAX_MARKET_EXCERPTS - own.length,
    excludeIds: ownIds,
  });
  const similar = await repositories.evidence.getByIds(hits.map((hit) => hit.id as EvidenceId));
  return [...own, ...similar].slice(0, MAX_MARKET_EXCERPTS);
}

/** The context with excerpt indexes replaced by the evidence they came from. */
export function storedContext(
  context: MarketContext,
  evidence: readonly Evidence[],
): MarketContextData {
  const idOf = (index: number): EvidenceId => {
    const item = evidence[index];
    if (item === undefined) throw new Error('a verified quote points to no evidence');
    return item.id;
  };
  return marketContextSchema.parse({
    version: 1,
    alternatives: context.alternatives.map(({ excerpt, ...item }) => ({
      ...item,
      evidenceId: idOf(excerpt),
    })),
    money: context.money.map(({ excerpt, ...item }) => ({ ...item, evidenceId: idOf(excerpt) })),
    buyers: context.buyers.map(({ excerpt, ...item }) => ({ ...item, evidenceId: idOf(excerpt) })),
  });
}

/**
 * The market context agent (PHASE 10): for draft opportunities, the AI lists alternatives,
 * money and buyers from the evidence with quotes; code keeps only quoted items and reads amounts
 * from the quotes; the result is a `market_data` entry of the Company Brain linked to the
 * opportunity and its evidence. Each opportunity version is worked on once.
 */
export function marketAnalystAgent(options: { readonly batchSize?: number } = {}): AgentDefinition {
  return {
    key: MARKET_ANALYST.id,
    actor: MARKET_ANALYST,
    access: MARKET_ANALYST_ACCESS,
    tasks: [marketContextTask],

    async run(context): Promise<AgentReport> {
      const { database, logger } = context;
      await assertAgentsRunning(database);
      if ((await activePrincipal(database, MARKET_ANALYST)) === undefined) {
        return { outcome: 'no_access', processed: 0 };
      }
      const opportunities = await database.agentWork.pendingOpportunities({
        agent: MARKET_ANALYST.id,
        limit: options.batchSize ?? DEFAULT_BATCH,
      });
      if (opportunities.length === 0) return { outcome: 'idle', processed: 0 };

      let processed = 0;
      let stored = 0;
      let stoppedBy: AgentStop | undefined;
      const entry = (
        opportunity: Opportunity,
        outcome: AgentWorkOutcome,
        correlationId: string,
        result: AgentWorkResult = {},
      ) => ({
        agent: MARKET_ANALYST.id,
        subjectType: 'opportunity' as const,
        subjectId: opportunity.id,
        subjectVersion: opportunity.version,
        task: marketContextTask.name,
        taskVersion: marketContextTask.version,
        outcome,
        result,
        actorType: MARKET_ANALYST.type,
        actorId: MARKET_ANALYST.id,
        correlationId,
      });
      const record = async (
        opportunity: Opportunity,
        outcome: AgentWorkOutcome,
        correlationId: string,
      ) => {
        await database.agentWork.record(entry(opportunity, outcome, correlationId));
        processed += 1;
      };

      for (const opportunity of opportunities) {
        if (context.signal.aborted) break;
        const correlationId = `market-${opportunity.id}-v${String(opportunity.version)}`;
        const evidence = await materialFor(context, opportunity);
        if (evidence.length === 0) {
          await record(opportunity, 'empty', correlationId);
          continue;
        }
        const excerpts = evidence.map((item) => clip(item.excerpt, EXCERPT_LENGTH));

        let market: MarketContext;
        try {
          const answer = await context.runtime.runTask(
            marketContextTask,
            {
              opportunity: {
                title: opportunity.title,
                summary: clip(opportunity.summary, 1_000),
                icp: clip(opportunity.icp, 1_000),
              },
              excerpts,
            },
            { actor: MARKET_ANALYST, correlationId, signal: context.signal },
          );
          market = toMarketContext(excerpts, answer);
        } catch (error) {
          if (!(error instanceof AiTaskError)) throw error;
          if (error.code === 'invalid_input') {
            await record(opportunity, 'rejected', correlationId);
            continue;
          }
          if (error.code === 'failed') await record(opportunity, 'failed', correlationId);
          stoppedBy = stopOf(error);
          break;
        }
        if (isEmptyContext(market)) {
          await record(opportunity, 'empty', correlationId);
          continue;
        }

        const body = storedContext(market, evidence);
        const cited = [
          ...new Set(
            [...body.alternatives, ...body.money, ...body.buyers].map((item) => item.evidenceId),
          ),
        ];
        const asset = createKnowledgeAsset(
          {
            kind: 'market_data',
            title: clip(`Market context: ${opportunity.title}`, 200),
            summary: clip(marketSummary(market), 3_000),
            body: JSON.stringify(body),
            links: { evidenceIds: cited, opportunityId: opportunity.id },
            tags: [MARKET_CONTEXT_TAG],
          },
          {
            id: knowledgeAssetIdSchema.parse(uuidv7()),
            actor: MARKET_ANALYST,
            at: toTimestamp(new Date(context.now())),
          },
        );
        await database.transaction(
          async (scope) => {
            await scope.repositories.knowledgeAssets.insert(asset);
            await scope.agentWork.record(
              entry(opportunity, 'done', correlationId, {
                knowledge_asset: asset.id,
                alternatives: body.alternatives.length,
                money: body.money.length,
                buyers: body.buyers.length,
              }),
            );
          },
          { correlationId },
        );
        processed += 1;
        stored += 1;
      }

      logger.info('market context', { analyzed: processed, stored, stopped_by: stoppedBy });
      return { outcome: 'done', processed, stoppedBy };
    },
  };
}
