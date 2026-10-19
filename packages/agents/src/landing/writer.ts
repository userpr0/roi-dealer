import { AiTaskError } from '@roi-dealer/ai-runtime';
import type {
  AgentStop,
  AgentWorkOutcome,
  AgentWorkResult,
  AgentWorkSubject,
} from '@roi-dealer/database';
import {
  createMediaAsset,
  MAX_LANDING_REWRITES,
  mediaAssetIdSchema,
  toTimestamp,
  type Actor,
  type Experiment,
  type LandingContent,
  type MediaAsset,
  type NewPrincipal,
} from '@roi-dealer/domain';
import {
  checkLanding,
  landingSlug,
  newPreviewToken,
  writeLandingTask,
  type WriteLandingInput,
} from '@roi-dealer/media';
import { uuidv7 } from '@roi-dealer/shared';
import {
  activePrincipal,
  assertAgentsRunning,
  type AgentContext,
  type AgentDefinition,
  type AgentReport,
} from '../agent.js';

/** The agent identity landing pages are written as (PHASE 19a): the owner grants it in /decisions. */
export const LANDING_WRITER: Actor = { type: 'agent', id: 'landing-writer' };

export const LANDING_WRITER_ACCESS: NewPrincipal = {
  actor: LANDING_WRITER,
  displayName: 'Автор лендингов',
  purpose:
    'Для тестов, которым нужен лендинг (§7.1 C), пишет страницу и три рекламных текста по ' +
    'гипотезе. Код проверяет текст: без выдуманных отзывов, цифр и гарантий; цену и честную ' +
    'пометку ставит код. Страница видна только в предпросмотре, пока вы её не одобрите. ' +
    'Ничего не тратит; AI — в пределах 3 % дневной квоты.',
};

/** The first answer and one fix with the list of issues. */
export const LANDING_ATTEMPTS = 2;
const DEFAULT_BATCH = 2;

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function stopOf(error: AiTaskError): AgentStop {
  return error.code === 'budget' || error.code === 'unavailable' ? error.code : 'failed';
}

/**
 * The landing writer (PHASE 19a): for each test that needs a landing, the AI writes the page
 * and three ads; code checks them and asks once for a fix; a checked page is stored as a draft
 * asset with the agent's work, in one transaction. The owner approves or rejects it; after a
 * rejection the page is written again (at most `MAX_LANDING_REWRITES` times).
 */
export function landingWriterAgent(options: { readonly batchSize?: number } = {}): AgentDefinition {
  return {
    key: LANDING_WRITER.id,
    actor: LANDING_WRITER,
    access: LANDING_WRITER_ACCESS,
    tasks: [writeLandingTask],

    async run(context: AgentContext): Promise<AgentReport> {
      const { database, logger } = context;
      await assertAgentsRunning(database);
      if ((await activePrincipal(database, LANDING_WRITER)) === undefined) {
        return { outcome: 'no_access', processed: 0 };
      }
      const pending = await database.agentWork.pendingLandings({
        agent: LANDING_WRITER.id,
        maxRewrites: MAX_LANDING_REWRITES,
        limit: options.batchSize ?? DEFAULT_BATCH,
      });
      if (pending.length === 0) return { outcome: 'idle', processed: 0 };

      let processed = 0;
      let written = 0;
      let stoppedBy: AgentStop | undefined;
      for (const { experiment, rework } of pending) {
        if (context.signal.aborted || stoppedBy !== undefined) break;
        const { repositories } = database;
        const rejected =
          rework === undefined ? undefined : await repositories.mediaAssets.getById(rework);
        // The work is recorded on what it answers: the test, or the rejected page it rewrites.
        const subject: { type: AgentWorkSubject; id: string; version: number } =
          rejected === undefined
            ? { type: 'experiment', id: experiment.id, version: experiment.version }
            : { type: 'media_asset', id: rejected.id, version: rejected.version };
        const correlationId = `landing-${subject.id}-v${String(subject.version)}`;
        const entry = (outcome: AgentWorkOutcome, result: AgentWorkResult = {}) => ({
          agent: LANDING_WRITER.id,
          subjectType: subject.type,
          subjectId: subject.id,
          subjectVersion: subject.version,
          task: writeLandingTask.name,
          taskVersion: writeLandingTask.version,
          outcome,
          result,
          actorType: LANDING_WRITER.type,
          actorId: LANDING_WRITER.id,
          correlationId,
        });

        const material = await materialFor(context, experiment, rejected);
        if (material === undefined) {
          await database.agentWork.record(entry('rejected', { reason: 'missing_hypothesis' }));
          processed += 1;
          continue;
        }
        let feedback = '';
        let content: LandingContent | undefined;
        let attempts = 0;
        try {
          while (content === undefined && attempts < LANDING_ATTEMPTS) {
            attempts += 1;
            const answer = await context.runtime.runTask(
              writeLandingTask,
              { ...material, feedback },
              { actor: LANDING_WRITER, correlationId, signal: context.signal },
            );
            const checked = checkLanding({ ...material, feedback }, answer);
            if ('content' in checked) content = checked.content;
            else feedback = clip(checked.issues.join('; '), 1_500);
          }
        } catch (error) {
          if (!(error instanceof AiTaskError)) throw error;
          if (error.code === 'invalid_input') {
            await database.agentWork.record(entry('rejected'));
            processed += 1;
            continue;
          }
          if (error.code === 'failed') {
            await database.agentWork.record(entry('failed'));
            processed += 1;
          }
          stoppedBy = stopOf(error);
          break;
        }
        if (content === undefined) {
          await database.agentWork.record(entry('rejected', { attempts }));
          processed += 1;
          continue;
        }
        const id = mediaAssetIdSchema.parse(uuidv7());
        const opportunity = await repositories.opportunities.getById(experiment.opportunityId);
        const asset = createMediaAsset(
          {
            kind: 'landing',
            experimentId: experiment.id,
            hypothesisId: experiment.hypothesisId,
            opportunityId: experiment.opportunityId,
            content,
            slug: landingSlug(opportunity?.title ?? 'landing', id),
            previewToken: newPreviewToken(),
          },
          { id, actor: LANDING_WRITER, at: toTimestamp(new Date(context.now())) },
        );
        await database.transaction(
          async (scope) => {
            await scope.repositories.mediaAssets.insert(asset);
            await scope.agentWork.record(entry('done', { asset: asset.id, attempts }));
          },
          { correlationId },
        );
        processed += 1;
        written += 1;
      }

      logger.info('landings', { written, processed, stopped_by: stoppedBy });
      return { outcome: 'done', processed, stoppedBy };
    },
  };
}

/** The hypothesis and opportunity of the test as the writer sees them. */
async function materialFor(
  context: AgentContext,
  experiment: Experiment,
  rejected: MediaAsset | undefined,
): Promise<Omit<WriteLandingInput, 'feedback'> | undefined> {
  const { repositories } = context.database;
  const hypothesis = await repositories.hypotheses.getById(experiment.hypothesisId);
  const opportunity = await repositories.opportunities.getById(experiment.opportunityId);
  if (hypothesis === undefined || opportunity === undefined) return undefined;
  return {
    opportunity: {
      title: clip(opportunity.title, 200),
      icp: clip(opportunity.icp, 500),
      problem: clip(opportunity.valueProposition.problem, 500),
      change: clip(opportunity.valueProposition.change, 500),
      measurableResult: clip(opportunity.valueProposition.measurableResult, 300),
    },
    hypothesis: {
      audience: clip(hypothesis.audience, 500),
      offer: clip(hypothesis.offer, 500),
      priceUsd: hypothesis.price.amountCents / 100,
      channel: clip(hypothesis.channel, 100),
      creative: clip(hypothesis.creative, 1_000),
      cta: clip(hypothesis.cta, 200),
      method: hypothesis.validationMethod,
    },
    rejectedHeadline: rejected === undefined ? '' : clip(rejected.content.headline, 200),
  };
}
