import { AiTaskError, type AiRuntime, type TaskContext } from '@roi-dealer/ai-runtime';
import {
  addSignalToPain,
  assertAutomationRunning,
  AUTOMATION_CONTROL_ID,
  changeSignalStatus,
  createPain,
  createSignal,
  distinctSources,
  MIN_SOURCES_FOR_VALIDATED_PAIN,
  painHasRoom,
  painIdSchema,
  SEVERITY_BY_STRENGTH,
  signalIdSchema,
  toTimestamp,
  validatePain,
  type Actor,
  type CountryCode,
  type DomainContext,
  type Evidence,
  type NewPrincipal,
  type Pain,
  type PainId,
  type Principal,
  type Signal,
  type SourceId,
  type Timestamp,
} from '@roi-dealer/domain';
import type { Database, SignalExtractionOutcome, TransactionScope } from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';
import { uuidv7 } from '@roi-dealer/shared';
import { closestPains } from './similarity.js';
import { extractSignalTask, toSignalDraft, type SignalDraft } from './tasks/extract-signal.js';
import { matchedKey, matchPainTask, NO_MATCH } from './tasks/match-pain.js';

/** The agent identity the analysis runs as (PHASE 04): the owner grants it in /decisions. */
export const PAIN_ANALYST: Actor = { type: 'agent', id: 'pain-analyst' };

export const PAIN_ANALYST_ACCESS: NewPrincipal = {
  actor: PAIN_ANALYST,
  displayName: 'Агент болей и сигналов',
  purpose:
    'Читает новые доказательства и с помощью AI находит в них боли: сигнал с цитатой и ссылкой ' +
    'на пост, похожие сигналы — в одного кандидата боли. Только предлагает: решений, денег и ' +
    'доступов не касается. AI — в пределах 20 % дневной квоты.',
};

/** D-008: when neither the evidence nor its source names a market. */
const DEFAULT_MARKETS: readonly CountryCode[] = ['US', 'GB', 'CA', 'AU'];
const DEFAULT_BATCH = 20;
const TITLE_LENGTH = 200;

export interface SignalsDeps {
  readonly database: Database;
  readonly logger: Logger;
  readonly runtime: Pick<AiRuntime, 'runTask'>;
  /** Default: `Date.now`. */
  readonly now?: () => number;
}

/** Why a run ended before its batch: no budget left, no usable model, or every model failed. */
export type AnalysisStop = 'budget' | 'unavailable' | 'failed';

export type AnalysisOutcome =
  | {
      readonly status: 'analyzed';
      readonly analyzed: number;
      readonly signals: number;
      readonly newPains: number;
      readonly validated: number;
      readonly stoppedBy?: AnalysisStop | undefined;
    }
  | {
      readonly status: 'skipped';
      readonly reason: 'access_missing' | 'access_not_active' | 'nothing_new';
    };

/** Kill switch (13b): every automation checks it as its first step. */
export async function assertSignalsRunning(database: Database): Promise<void> {
  const control = await database.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
  if (control === undefined)
    throw new Error('the automation kill switch is missing (migration 0003)');
  assertAutomationRunning(control);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function stopOf(error: AiTaskError): AnalysisStop {
  return error.code === 'budget' || error.code === 'unavailable' ? error.code : 'failed';
}

interface Stored {
  readonly pain: Pain;
  readonly created: boolean;
  readonly validated: boolean;
}

/**
 * The signal, its pain (new or joined) and the journal row in one transaction. A pain whose
 * evidence now comes from two sources is validated by the domain rule (PHASE 01).
 */
async function storeSignal(
  scope: TransactionScope,
  evidence: Evidence,
  signal: Signal,
  target: Pain | undefined,
  draft: SignalDraft,
  context: DomainContext,
  correlationId: string,
): Promise<Stored> {
  const { repositories } = scope;
  await repositories.signals.insert(signal);
  await repositories.signals.update(changeSignalStatus(signal, 'triaged', context), PAIN_ANALYST);

  let pain: Pain;
  if (target === undefined) {
    pain = createPain(
      {
        title: signal.title,
        description: `${draft.statement}\n\nQuote: "${draft.quote}"`,
        audience: draft.audience,
        desiredOutcome: draft.outcome,
        severity: SEVERITY_BY_STRENGTH[draft.strength],
        frequency: 'rare',
        markets: signal.markets,
        signalIds: [signal.id],
        evidenceIds: signal.evidenceIds,
      },
      { id: painIdSchema.parse(uuidv7()), ...context },
    );
    await repositories.pains.insert(pain);
  } else {
    pain = addSignalToPain(target, signal, context);
    await repositories.pains.update(pain, PAIN_ANALYST);
  }

  let validated = false;
  if (pain.status === 'candidate') {
    const painEvidence = await repositories.evidence.getByIds(pain.evidenceIds);
    if (distinctSources(painEvidence).size >= MIN_SOURCES_FOR_VALIDATED_PAIN) {
      pain = validatePain(pain, painEvidence, context);
      await repositories.pains.update(pain, PAIN_ANALYST);
      validated = true;
    }
  }

  await scope.signalExtractions.record({
    evidenceId: evidence.id,
    taskVersion: extractSignalTask.version,
    outcome: 'signal',
    signalId: signal.id,
    painId: pain.id,
    actorType: PAIN_ANALYST.type,
    actorId: PAIN_ANALYST.id,
    correlationId,
  });
  return { pain, created: target === undefined, validated };
}

/**
 * One run of the pain analyst (PHASE 06): kill switch → active identity → up to `batchSize`
 * Evidence not analyzed yet → for each: the AI finds a pain, code checks the quote, the closest
 * open pains are compared (words first, then the AI) and the signal starts or joins a pain.
 * Every Evidence is recorded once. No budget or no model stops the run; the rest waits.
 */
export async function analyzeEvidence(
  deps: SignalsDeps,
  options: {
    readonly batchSize?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<AnalysisOutcome> {
  const { database, logger, runtime } = deps;
  await assertSignalsRunning(database);
  const principal: Principal | undefined =
    await database.repositories.principals.getByActor(PAIN_ANALYST);
  if (principal === undefined) return { status: 'skipped', reason: 'access_missing' };
  if (principal.status !== 'active') return { status: 'skipped', reason: 'access_not_active' };

  const batch = await database.signalExtractions.pending({
    limit: options.batchSize ?? DEFAULT_BATCH,
  });
  if (batch.length === 0) return { status: 'skipped', reason: 'nothing_new' };

  const pains = new Map<PainId, Pain>();
  for (const status of ['validated', 'candidate'] as const) {
    for (const pain of await database.repositories.pains.listByStatus(status, { limit: 1_000 })) {
      pains.set(pain.id, pain);
    }
  }
  const sourceMarkets = new Map<SourceId, readonly CountryCode[]>();
  const nowTimestamp = (): Timestamp => toTimestamp(new Date((deps.now ?? Date.now)()));

  let analyzed = 0;
  let signals = 0;
  let newPains = 0;
  let validated = 0;
  let stoppedBy: AnalysisStop | undefined;

  const record = async (evidence: Evidence, outcome: SignalExtractionOutcome, id: string) => {
    await database.signalExtractions.record({
      evidenceId: evidence.id,
      taskVersion: extractSignalTask.version,
      outcome,
      actorType: PAIN_ANALYST.type,
      actorId: PAIN_ANALYST.id,
      correlationId: id,
    });
    analyzed += 1;
  };

  for (const evidence of batch) {
    if (options.signal?.aborted === true) break;
    const correlationId = `signals-${evidence.id}`;
    const context: TaskContext = { actor: PAIN_ANALYST, correlationId, signal: options.signal };

    let draft: SignalDraft | 'rejected' | undefined;
    try {
      const answer = await runtime.runTask(extractSignalTask, { text: evidence.excerpt }, context);
      draft = toSignalDraft(evidence.excerpt, answer);
    } catch (error) {
      if (!(error instanceof AiTaskError)) throw error;
      if (error.code === 'invalid_input') {
        await record(evidence, 'rejected', correlationId);
        continue;
      }
      // Every model failed on this one: recorded, so it does not block the queue.
      if (error.code === 'failed') await record(evidence, 'failed', correlationId);
      stoppedBy = stopOf(error);
      break;
    }
    if (draft === undefined || draft === 'rejected') {
      await record(evidence, draft ?? 'no_pain', correlationId);
      continue;
    }

    let markets = sourceMarkets.get(evidence.sourceId);
    if (markets === undefined) {
      const source = await database.repositories.sources.getById(evidence.sourceId);
      markets = source?.markets ?? DEFAULT_MARKETS;
      sourceMarkets.set(evidence.sourceId, markets);
    }
    const at = nowTimestamp();
    const domainContext: DomainContext = { actor: PAIN_ANALYST, at };
    const signal = createSignal(
      {
        title: clip(draft.statement, TITLE_LENGTH),
        summary: [
          draft.statement,
          `Audience: ${draft.audience}`,
          `Desired outcome: ${draft.outcome}`,
          `Quote: "${draft.quote}"`,
        ].join('\n'),
        evidenceIds: [evidence.id],
        markets: evidence.market === undefined ? [...markets] : [evidence.market],
        strength: draft.strength,
      },
      { id: signalIdSchema.parse(uuidv7()), ...domainContext },
    );

    // Words first (free), then the AI on the closest few.
    const candidates = closestPains(
      draft.statement,
      draft.audience,
      [...pains.values()].filter(painHasRoom),
    );
    let target: Pain | undefined;
    if (candidates.length > 0) {
      const keys = candidates.map((_, index) => `P${String(index + 1)}`);
      try {
        const answer = await runtime.runTask(
          matchPainTask,
          {
            statement: clip(draft.statement, 300),
            audience: clip(draft.audience, 200),
            candidates: candidates.map((pain, index) => ({
              key: keys[index] ?? '',
              statement: clip(pain.title, 300),
              audience: clip(pain.audience, 200),
            })),
          },
          context,
        );
        const key = matchedKey(answer, keys);
        target = key === NO_MATCH ? undefined : candidates[keys.indexOf(key)];
      } catch (error) {
        if (!(error instanceof AiTaskError)) throw error;
        // Not recorded: the evidence is analyzed again next time.
        stoppedBy = stopOf(error);
        break;
      }
    }

    const stored = await database.transaction(
      (scope) => storeSignal(scope, evidence, signal, target, draft, domainContext, correlationId),
      { correlationId },
    );
    pains.set(stored.pain.id, stored.pain);
    analyzed += 1;
    signals += 1;
    if (stored.created) newPains += 1;
    if (stored.validated) validated += 1;
  }

  logger.info('pain analysis', {
    analyzed,
    signals,
    new_pains: newPains,
    validated,
    stopped_by: stoppedBy,
  });
  return { status: 'analyzed', analyzed, signals, newPains, validated, stoppedBy };
}
