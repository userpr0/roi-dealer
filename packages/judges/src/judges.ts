import {
  activePrincipal,
  assertAgentsRunning,
  type AgentContext,
  type AgentDefinition,
  type AgentReport,
} from '@roi-dealer/agents';
import { AiTaskError } from '@roi-dealer/ai-runtime';
import { similarCases } from '@roi-dealer/brain';
import type { AgentStop, JudgementOutcome } from '@roi-dealer/database';
import {
  distinctSources,
  JUDGE_CRITERIA,
  MARKET_CONTEXT_TAG,
  submitOpportunityForReview,
  timestampMs,
  toTimestamp,
  type Actor,
  type Evidence,
  type JudgeCriterion,
  type NewPrincipal,
  type Opportunity,
} from '@roi-dealer/domain';
import {
  JUDGE_EXCERPT_LENGTH,
  judgeOpportunityTask,
  MAX_JUDGE_EXCERPTS,
  toJudgement,
  type CheckedJudgement,
  type JudgeInput,
} from './judge-opportunity.js';

/** The agent identity the judges run as (PHASE 04): the owner grants it in /decisions. */
export const JUDGES: Actor = { type: 'agent', id: 'judges' };

export const JUDGES_ACCESS: NewPrincipal = {
  actor: JUDGES,
  displayName: 'Судьи',
  purpose:
    'Шесть судей по отдельности оценивают каждый черновик возможности: рынок, боль и ' +
    'ценность, экономику, сборку, риск, повторное использование. Балл 1–5 с обоснованием и ' +
    'ссылками на доказательства; без ссылок у рынка, боли и экономики балл не выше 2. Итог ' +
    'считает код. Оценённую возможность отправляет вам на решение; решения, деньги и доступы ' +
    'не трогает. AI — сильные модели, в пределах 30 % дневной квоты.',
};

const DEFAULT_BATCH = 2;
/** Judges wait for the market context of a version this long at most. */
export const MARKET_WAIT_MS = 24 * 3_600_000;
const MARKET_AGENT = 'market-analyst';

export interface JudgesOptions {
  /** Opportunities per run; default 2. */
  readonly batchSize?: number;
  readonly marketWaitMs?: number;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function stopOf(error: AiTaskError): AgentStop {
  return error.code === 'budget' || error.code === 'unavailable' ? error.code : 'failed';
}

/** What every judge of an opportunity gets: the card, numbers from the database, evidence. */
async function materialFor(
  context: AgentContext,
  opportunity: Opportunity,
): Promise<{ readonly input: Omit<JudgeInput, 'criterion'>; readonly evidence: Evidence[] }> {
  const { repositories, opportunityAssessments } = context.database;
  const pains = await repositories.pains.getByIds(opportunity.painIds);
  const all = await repositories.evidence.getByIds([
    ...new Set(pains.flatMap((pain) => pain.evidenceIds)),
  ]);
  const evidence = [...all]
    .sort((a, b) => timestampMs(b.observedAt) - timestampMs(a.observedAt))
    .slice(0, MAX_JUDGE_EXCERPTS);
  const score = (await opportunityAssessments.scores([opportunity.id])).get(opportunity.id);
  const signals = pains.reduce((sum, pain) => sum + pain.signalIds.length, 0);
  const facts = [
    `${String(signals)} signals from ${String(distinctSources(all).size)} sources`,
    score === undefined
      ? undefined
      : `PHASE 07 score ${String(score.score)}/100 (${Object.entries(score.components)
          .map(([part, value]) => `${part} ${String(value)}`)
          .join(', ')})`,
  ]
    .filter((part) => part !== undefined)
    .join('; ');
  const [market] = await repositories.knowledgeAssets.listByTags([MARKET_CONTEXT_TAG], {
    opportunityIds: [opportunity.id],
    limit: 1,
  });
  const cases = await similarCases(context.database, `${opportunity.title} ${opportunity.icp}`, {
    excludeIds: [opportunity.id, ...(market === undefined ? [] : [market.id])],
    limit: 3,
  });
  const model = opportunity.businessModel;
  return {
    evidence,
    input: {
      opportunity: {
        title: opportunity.title,
        summary: clip(opportunity.summary, 1_000),
        icp: clip(opportunity.icp, 500),
        problem: clip(opportunity.valueProposition.problem, 500),
        change: clip(opportunity.valueProposition.change, 500),
        measurableResult: clip(opportunity.valueProposition.measurableResult, 300),
        businessModel: clip(
          model.pricingHypothesis === undefined
            ? model.model
            : `${model.model} — ${model.pricingHypothesis}`,
          300,
        ),
      },
      facts: clip(facts, 500),
      excerpts: evidence.map((item) => clip(item.excerpt, JUDGE_EXCERPT_LENGTH)),
      market: market === undefined ? '' : clip(market.summary, 1_000),
      similarCases: cases.map((hit) => clip(`${hit.title}: ${hit.snippet}`, 300)),
    },
  };
}

/**
 * The judges (PHASE 11): for draft opportunities whose market context is ready, six separate
 * calls of `judge-opportunity`, one per criterion; code checks every answer. When all six are
 * recorded for a version, the opportunity goes to the owner's review queue. A run that ends
 * early (budget) continues with the remaining criteria next time.
 */
export function judgesAgent(options: JudgesOptions = {}): AgentDefinition {
  return {
    key: JUDGES.id,
    actor: JUDGES,
    access: JUDGES_ACCESS,
    tasks: [judgeOpportunityTask],

    async run(context): Promise<AgentReport> {
      const { database, logger } = context;
      await assertAgentsRunning(database);
      if ((await activePrincipal(database, JUDGES)) === undefined) {
        return { outcome: 'no_access', processed: 0 };
      }
      const opportunities = await database.judgements.pending({
        marketAgent: MARKET_AGENT,
        waitMs: options.marketWaitMs ?? MARKET_WAIT_MS,
        limit: options.batchSize ?? DEFAULT_BATCH,
      });
      if (opportunities.length === 0) return { outcome: 'idle', processed: 0 };

      let processed = 0;
      let submitted = 0;
      let stoppedBy: AgentStop | undefined;

      for (const opportunity of opportunities) {
        if (context.signal.aborted || stoppedBy !== undefined) break;
        const previous = (await database.judgements.latest([opportunity.id])).get(opportunity.id);
        const done = new Set<JudgeCriterion>(
          (previous ?? [])
            .filter((item) => item.opportunityVersion === opportunity.version)
            .map((item) => item.criterion),
        );
        const { input, evidence } = await materialFor(context, opportunity);

        const record = async (
          criterion: JudgeCriterion,
          outcome: JudgementOutcome,
          correlationId: string,
          judgement?: CheckedJudgement,
        ) => {
          await database.judgements.record({
            opportunityId: opportunity.id,
            opportunityVersion: opportunity.version,
            criterion,
            taskVersion: judgeOpportunityTask.version,
            outcome,
            ...(judgement === undefined
              ? {}
              : {
                  score: judgement.score,
                  supported: judgement.supported,
                  rationale: judgement.rationale,
                  concerns: judgement.concerns,
                  evidenceIds: judgement.evidence.flatMap((index) => {
                    const item = evidence[index];
                    return item === undefined ? [] : [item.id];
                  }),
                }),
            actorType: JUDGES.type,
            actorId: JUDGES.id,
            correlationId,
          });
          done.add(criterion);
          processed += 1;
        };

        for (const criterion of JUDGE_CRITERIA) {
          if (done.has(criterion)) continue;
          if (context.signal.aborted) break;
          const correlationId = `judge-${opportunity.id}-v${String(opportunity.version)}-${criterion}`;
          if (input.excerpts.length === 0) {
            await record(criterion, 'rejected', correlationId);
            continue;
          }
          try {
            const answer = await context.runtime.runTask(
              judgeOpportunityTask,
              { ...input, criterion },
              { actor: JUDGES, correlationId, signal: context.signal },
            );
            const judgement = toJudgement(criterion, input.excerpts.length, answer);
            if (judgement === 'rejected') await record(criterion, 'rejected', correlationId);
            else await record(criterion, 'judged', correlationId, judgement);
          } catch (error) {
            if (!(error instanceof AiTaskError)) throw error;
            if (error.code === 'invalid_input') {
              await record(criterion, 'rejected', correlationId);
              continue;
            }
            if (error.code === 'failed') await record(criterion, 'failed', correlationId);
            stoppedBy = stopOf(error);
            break;
          }
        }

        if (done.size === JUDGE_CRITERIA.length) {
          const correlationId = `judge-${opportunity.id}-v${String(opportunity.version)}-review`;
          const next = submitOpportunityForReview(opportunity, {
            actor: JUDGES,
            at: toTimestamp(new Date(context.now())),
          });
          await database.transaction(
            async (scope) => {
              await scope.repositories.opportunities.update(next, JUDGES);
            },
            { correlationId },
          );
          submitted += 1;
        }
      }

      logger.info('judges', { judged: processed, submitted, stopped_by: stoppedBy });
      return { outcome: 'done', processed, stoppedBy };
    },
  };
}
