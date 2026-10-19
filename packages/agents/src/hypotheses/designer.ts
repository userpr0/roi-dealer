import { AiTaskError } from '@roi-dealer/ai-runtime';
import type { AgentStop, AgentWorkOutcome, AgentWorkResult } from '@roi-dealer/database';
import {
  createHypothesis,
  hypothesisIdSchema,
  JUDGE_CRITERIA,
  judgePanel,
  MARKET_CONTEXT_TAG,
  timestampMs,
  toTimestamp,
  type Actor,
  type JudgeCriterion,
  type NewHypothesis,
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
  designHypothesesTask,
  MAX_HYPOTHESIS_BUDGET_USD,
  MAX_SET_BUDGET_USD,
  toHypothesisSet,
  type DesignHypothesesInput,
} from './design-hypotheses.js';

/** The agent identity hypotheses are designed as (PHASE 04): the owner grants it in /decisions. */
export const HYPOTHESIS_DESIGNER: Actor = { type: 'agent', id: 'hypothesis-designer' };

export const HYPOTHESIS_DESIGNER_ACCESS: NewPrincipal = {
  actor: HYPOTHESIS_DESIGNER,
  displayName: 'Агент гипотез',
  purpose:
    'Для возможностей, которые вы одобрили, предлагает пять разных гипотез проверки (§7.1): ' +
    'аудитория, рынок, оффер, цена, канал, демо, CTA, метрика успеха, бюджет и stop-loss. Код ' +
    `проверяет поля и разнообразие; бюджет одной гипотезы — не больше $${String(MAX_HYPOTHESIS_BUDGET_USD)}, ` +
    `всех пяти — не больше $${String(MAX_SET_BUDGET_USD)}. Ничего не тратит: эксперимент ` +
    'запускается только с вашего одобрения. AI — в пределах 5 % дневной квоты.',
};

const DEFAULT_BATCH = 2;
/** The first answer and one fix with the list of issues. */
export const DESIGN_ATTEMPTS = 2;
const EXCERPTS = 4;

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function stopOf(error: AiTaskError): AgentStop {
  return error.code === 'budget' || error.code === 'unavailable' ? error.code : 'failed';
}

/** The opportunity, its evidence, market and judges as the designer sees them. */
async function materialFor(
  context: AgentContext,
  opportunity: Opportunity,
): Promise<Omit<DesignHypothesesInput, 'feedback'>> {
  const { repositories, judgements } = context.database;
  const pains = await repositories.pains.getByIds(opportunity.painIds);
  const evidence = [
    ...(await repositories.evidence.getByIds([
      ...new Set(pains.flatMap((pain) => pain.evidenceIds)),
    ])),
  ]
    .sort((a, b) => timestampMs(b.observedAt) - timestampMs(a.observedAt))
    .slice(0, EXCERPTS);
  const [market] = await repositories.knowledgeAssets.listByTags([MARKET_CONTEXT_TAG], {
    opportunityIds: [opportunity.id],
    limit: 1,
  });
  const judged = (await judgements.latest([opportunity.id])).get(opportunity.id) ?? [];
  const scores: Partial<Record<JudgeCriterion, number>> = {};
  for (const item of judged) {
    if (item.outcome === 'judged' && item.score !== undefined) scores[item.criterion] = item.score;
  }
  const panel = judgePanel(scores);
  const concerns = judged.flatMap((item) => item.concerns).slice(0, 4);
  const model = opportunity.businessModel;
  return {
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
    markets: [...opportunity.markets],
    excerpts: evidence.map((item) => clip(item.excerpt, 500)),
    market: market === undefined ? '' : clip(market.summary, 1_000),
    judges: clip(
      judged.length === 0
        ? ''
        : `Judges ${panel.total === undefined ? 'incomplete' : `${String(panel.total)}/100`} (` +
            JUDGE_CRITERIA.map(
              (criterion) => `${criterion} ${String(scores[criterion] ?? '-')}`,
            ).join(', ') +
            `); weak spots: ${panel.weak.length === 0 ? 'none' : panel.weak.join(', ')}` +
            (concerns.length === 0 ? '.' : `. Concerns: ${concerns.join('; ')}`),
      1_000,
    ),
  };
}

/**
 * The hypothesis designer (PHASE 14): for each approved opportunity, the AI proposes five
 * hypotheses; code checks them and asks once for a fix; a valid set is stored as five
 * `proposed` hypotheses with the agent's work, in one transaction. The owner picks what to test
 * and launches experiments (PHASE 15).
 */
export function hypothesisDesignerAgent(
  options: { readonly batchSize?: number } = {},
): AgentDefinition {
  return {
    key: HYPOTHESIS_DESIGNER.id,
    actor: HYPOTHESIS_DESIGNER,
    access: HYPOTHESIS_DESIGNER_ACCESS,
    tasks: [designHypothesesTask],

    async run(context): Promise<AgentReport> {
      const { database, logger } = context;
      await assertAgentsRunning(database);
      if ((await activePrincipal(database, HYPOTHESIS_DESIGNER)) === undefined) {
        return { outcome: 'no_access', processed: 0 };
      }
      const opportunities = await database.agentWork.pendingOpportunities({
        agent: HYPOTHESIS_DESIGNER.id,
        status: 'approved',
        limit: options.batchSize ?? DEFAULT_BATCH,
      });
      if (opportunities.length === 0) return { outcome: 'idle', processed: 0 };

      let processed = 0;
      let designed = 0;
      let stoppedBy: AgentStop | undefined;
      const entry = (
        opportunity: Opportunity,
        outcome: AgentWorkOutcome,
        correlationId: string,
        result: AgentWorkResult = {},
      ) => ({
        agent: HYPOTHESIS_DESIGNER.id,
        subjectType: 'opportunity' as const,
        subjectId: opportunity.id,
        subjectVersion: opportunity.version,
        task: designHypothesesTask.name,
        taskVersion: designHypothesesTask.version,
        outcome,
        result,
        actorType: HYPOTHESIS_DESIGNER.type,
        actorId: HYPOTHESIS_DESIGNER.id,
        correlationId,
      });

      for (const opportunity of opportunities) {
        if (context.signal.aborted || stoppedBy !== undefined) break;
        const correlationId = `hypotheses-${opportunity.id}-v${String(opportunity.version)}`;
        const material = await materialFor(context, opportunity);
        let feedback = '';
        let set: NewHypothesis[] | undefined;
        let attempts = 0;
        try {
          while (set === undefined && attempts < DESIGN_ATTEMPTS) {
            attempts += 1;
            const answer = await context.runtime.runTask(
              designHypothesesTask,
              { ...material, feedback },
              { actor: HYPOTHESIS_DESIGNER, correlationId, signal: context.signal },
            );
            const checked = toHypothesisSet(opportunity.id, material.markets, answer);
            if ('hypotheses' in checked) set = checked.hypotheses;
            else feedback = clip(checked.issues.join('; '), 1_500);
          }
        } catch (error) {
          if (!(error instanceof AiTaskError)) throw error;
          if (error.code === 'invalid_input') {
            await database.agentWork.record(entry(opportunity, 'rejected', correlationId));
            processed += 1;
            continue;
          }
          if (error.code === 'failed') {
            await database.agentWork.record(entry(opportunity, 'failed', correlationId));
            processed += 1;
          }
          stoppedBy = stopOf(error);
          break;
        }
        if (set === undefined) {
          await database.agentWork.record(
            entry(opportunity, 'rejected', correlationId, { attempts }),
          );
          processed += 1;
          continue;
        }
        const at = toTimestamp(new Date(context.now()));
        const hypotheses = set.map((data) =>
          createHypothesis(data, {
            id: hypothesisIdSchema.parse(uuidv7()),
            actor: HYPOTHESIS_DESIGNER,
            at,
          }),
        );
        await database.transaction(
          async (scope) => {
            for (const hypothesis of hypotheses)
              await scope.repositories.hypotheses.insert(hypothesis);
            await scope.agentWork.record(
              entry(opportunity, 'done', correlationId, {
                hypotheses: hypotheses.length,
                attempts,
              }),
            );
          },
          { correlationId },
        );
        processed += 1;
        designed += 1;
      }

      logger.info('hypotheses', { designed, processed, stopped_by: stoppedBy });
      return { outcome: 'done', processed, stoppedBy };
    },
  };
}
