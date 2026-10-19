import { AiTaskError, type AiRuntime, type TaskContext } from '@roi-dealer/ai-runtime';
import {
  assertAutomationRunning,
  AUTOMATION_CONTROL_ID,
  createOpportunity,
  distinctSources,
  opportunityIdSchema,
  timestampMs,
  toTimestamp,
  type Actor,
  type NewPrincipal,
  type Opportunity,
  type Pain,
} from '@roi-dealer/domain';
import type { Database, OpportunityAssessmentOutcome } from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';
import { uuidv7 } from '@roi-dealer/shared';
import { ROUTING_REASONS, routeBusinessModel } from './business-model.js';
import { OPPORTUNITY_THRESHOLD, scoreOpportunity, type OpportunityScoreResult } from './scoring.js';
import {
  frameOpportunityTask,
  MAX_EXCERPTS,
  toOpportunityDraft,
  type OpportunityDraft,
} from './tasks/frame-opportunity.js';

/** The agent identity the assessment runs as (PHASE 04): the owner grants it in /decisions. */
export const OPPORTUNITY_ANALYST: Actor = { type: 'agent', id: 'opportunity-analyst' };

export const OPPORTUNITY_ANALYST_ACCESS: NewPrincipal = {
  actor: OPPORTUNITY_ANALYST,
  displayName: 'Агент возможностей',
  purpose:
    'Берёт боли, которые повторяются (от 2 сигналов), и с помощью AI формулирует возможность: ' +
    'клиент, проблема, результат, признаки готовности платить. Оценку 0–100 и бизнес-модель ' +
    'считает код. Создаёт только черновики; решения, деньги и доступы не трогает. AI — в ' +
    'пределах 10 % дневной квоты.',
};

/** One complaint is not an opportunity (§7.1 A). */
export const MIN_SIGNALS_FOR_OPPORTUNITY = 2;
const DEFAULT_BATCH = 5;
const EXCERPT_LENGTH = 1_000;

export interface OpportunitiesDeps {
  readonly database: Database;
  readonly logger: Logger;
  readonly runtime: Pick<AiRuntime, 'runTask'>;
  /** Default: `Date.now`. */
  readonly now?: () => number;
}

export type AssessmentStop = 'budget' | 'unavailable' | 'failed';

export type AssessmentOutcome =
  | {
      readonly status: 'assessed';
      readonly assessed: number;
      readonly opportunities: number;
      readonly belowThreshold: number;
      readonly stoppedBy?: AssessmentStop | undefined;
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'access_missing' | 'access_not_active' | 'nothing_new';
    };

/** Kill switch (13b): every automation checks it as its first step. */
export async function assertOpportunitiesRunning(database: Database): Promise<void> {
  const control = await database.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
  if (control === undefined)
    throw new Error('the automation kill switch is missing (migration 0003)');
  assertAutomationRunning(control);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The opportunity as the code builds it from the pain, the checked answer and the score. */
export function opportunityFrom(
  pain: Pain,
  draft: OpportunityDraft,
  score: OpportunityScoreResult,
): { readonly data: Parameters<typeof createOpportunity>[0]; readonly reason: string } {
  const { model, reason } = routeBusinessModel(draft);
  const parts = Object.entries(score.components)
    .map(([part, value]) => `${part} ${String(value)}`)
    .join(', ');
  const proof = draft.paymentQuotes.map((quote) => `"${quote}"`).join('; ');
  return {
    reason,
    data: {
      title: draft.title,
      summary: clip(
        `${draft.summary}\n\nScore ${String(score.total)}/100 (${parts}).\n` +
          `Business model: ${model} — ${ROUTING_REASONS[reason]}.`,
        3_000,
      ),
      painIds: [pain.id],
      icp: draft.icp === '' ? pain.audience : draft.icp,
      markets: pain.markets,
      valueProposition: {
        problem: draft.problem,
        change: draft.change,
        measurableResult: draft.measurableResult,
        ...(proof === '' ? {} : { proof: clip(proof, 1_000) }),
      },
      businessModel: {
        model,
        ...(draft.pricingHypothesis === undefined
          ? {}
          : { pricingHypothesis: draft.pricingHypothesis }),
      },
    },
  };
}

function stopOf(error: AiTaskError): AssessmentStop {
  return error.code === 'budget' || error.code === 'unavailable' ? error.code : 'failed';
}

/**
 * One run of the opportunity analyst (PHASE 07): kill switch → active identity → up to
 * `batchSize` pains with ≥ 2 signals not assessed at their version → for each: the AI frames it,
 * code verifies the money quotes, scores it and routes the business model; a score of 55 or more
 * becomes a draft Opportunity. Every assessed version is recorded once.
 */
export async function assessPains(
  deps: OpportunitiesDeps,
  options: {
    readonly batchSize?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<AssessmentOutcome> {
  const { database, logger, runtime } = deps;
  await assertOpportunitiesRunning(database);
  const principal = await database.repositories.principals.getByActor(OPPORTUNITY_ANALYST);
  if (principal === undefined) return { status: 'skipped', reason: 'access_missing' };
  if (principal.status !== 'active') return { status: 'skipped', reason: 'access_not_active' };

  const batch = await database.opportunityAssessments.pending({
    minSignals: MIN_SIGNALS_FOR_OPPORTUNITY,
    limit: options.batchSize ?? DEFAULT_BATCH,
  });
  if (batch.length === 0) return { status: 'skipped', reason: 'nothing_new' };

  let assessed = 0;
  let opportunities = 0;
  let belowThreshold = 0;
  let stoppedBy: AssessmentStop | undefined;

  const record = async (
    pain: Pain,
    outcome: OpportunityAssessmentOutcome,
    correlationId: string,
    score?: OpportunityScoreResult,
  ) => {
    await database.opportunityAssessments.record({
      painId: pain.id,
      painVersion: pain.version,
      taskVersion: frameOpportunityTask.version,
      outcome,
      score: score?.total,
      components: score?.components,
      actorType: OPPORTUNITY_ANALYST.type,
      actorId: OPPORTUNITY_ANALYST.id,
      correlationId,
    });
    assessed += 1;
  };

  for (const pain of batch) {
    if (options.signal?.aborted === true) break;
    const correlationId = `opportunity-${pain.id}-v${String(pain.version)}`;
    const context: TaskContext = {
      actor: OPPORTUNITY_ANALYST,
      correlationId,
      signal: options.signal,
    };
    const evidence = await database.repositories.evidence.getByIds(pain.evidenceIds);
    const excerpts = [...evidence]
      .sort((a, b) => timestampMs(b.observedAt) - timestampMs(a.observedAt))
      .slice(0, MAX_EXCERPTS)
      .map((item) => clip(item.excerpt, EXCERPT_LENGTH));

    let draft: OpportunityDraft | 'rejected';
    try {
      const answer = await runtime.runTask(
        frameOpportunityTask,
        {
          pain: {
            title: pain.title,
            audience: pain.audience,
            desiredOutcome: pain.desiredOutcome,
          },
          excerpts,
        },
        context,
      );
      draft = toOpportunityDraft(excerpts, answer);
    } catch (error) {
      if (!(error instanceof AiTaskError)) throw error;
      if (error.code === 'invalid_input') {
        await record(pain, 'rejected', correlationId);
        continue;
      }
      // Every model failed on this pain: recorded, so it does not block the queue.
      if (error.code === 'failed') await record(pain, 'failed', correlationId);
      stoppedBy = stopOf(error);
      break;
    }
    if (draft === 'rejected') {
      await record(pain, 'rejected', correlationId);
      continue;
    }

    const score = scoreOpportunity({
      pain,
      sources: distinctSources(evidence).size,
      verifiedPaymentQuotes: draft.paymentQuotes.length,
      buyer: draft.buyer,
    });
    if (score.total < OPPORTUNITY_THRESHOLD) {
      await record(pain, 'below_threshold', correlationId, score);
      belowThreshold += 1;
      continue;
    }

    const { data } = opportunityFrom(pain, draft, score);
    const opportunity: Opportunity = createOpportunity(data, {
      id: opportunityIdSchema.parse(uuidv7()),
      actor: OPPORTUNITY_ANALYST,
      at: toTimestamp(new Date((deps.now ?? Date.now)())),
    });
    await database.transaction(
      async (scope) => {
        await scope.repositories.opportunities.insert(opportunity);
        await scope.opportunityAssessments.record({
          painId: pain.id,
          painVersion: pain.version,
          taskVersion: frameOpportunityTask.version,
          outcome: 'opportunity',
          score: score.total,
          components: score.components,
          opportunityId: opportunity.id,
          actorType: OPPORTUNITY_ANALYST.type,
          actorId: OPPORTUNITY_ANALYST.id,
          correlationId,
        });
      },
      { correlationId },
    );
    assessed += 1;
    opportunities += 1;
  }

  logger.info('opportunity assessment', {
    assessed,
    opportunities,
    below_threshold: belowThreshold,
    stopped_by: stoppedBy,
  });
  return { status: 'assessed', assessed, opportunities, belowThreshold, stoppedBy };
}
