import {
  applyOpportunityDecision,
  assertAutomationRunning,
  AUTOMATION_CONTROL_ID,
  createDecision,
  decisionIdSchema,
  distinctSources,
  DomainError,
  JUDGE_CRITERIA,
  judgePanel,
  MARKET_CONTEXT_TAG,
  opportunityIdSchema,
  readMarketContext,
  recommendOpportunity,
  timestampMs,
  toTimestamp,
  type Actor,
  type Evidence,
  type JudgeCriterion,
  type JudgePanel,
  type MarketContextData,
  type Opportunity,
  type Recommendation,
  type ReviewOutcome,
  type Timestamp,
} from '@roi-dealer/domain';
import {
  ConcurrencyError,
  type Database,
  type JudgementLog,
  type OpportunityAssessmentLog,
  type OpportunityScore,
  type Repositories,
  type StoredJudgement,
} from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';
import { uuidv7 } from '@roi-dealer/shared';
import { callbackButton, type CallbackContext, type InlineKeyboard } from '@roi-dealer/telegram';
import {
  CRITERION_LABELS,
  judgesLines,
  marketLine,
  MODEL_LABELS,
  PART_LABELS,
} from './opportunities.js';
import { AUTO_PAUSE_PREFIX } from '@roi-dealer/economics';
import { activeExperimentViews } from './experiments.js';
import { hypothesesReadyText } from './hypotheses.js';
import { newLeadText } from './leads.js';
import { landingCardContext, landingCardText, landingKeyboard } from './media.js';
import { shorten } from './texts.js';

/*
 * Decision Engine (PHASE 12): the card of an opportunity under review, with every fact from the
 * database and the system's recommendation, and the owner's buttons. A press asks for
 * confirmation, then one idempotent command records the owner's Decision and applies it.
 */

/** Buttons of opportunity cards: `op:<action>:<opportunity id>:<version>`. */
export const OPPORTUNITY_PREFIX = 'op';
/** Opportunity cards per /decisions reply. */
export const MAX_OPPORTUNITY_CARDS = 5;
/** How often the bot looks for opportunities to send. */
export const CARD_INTERVAL_MS = 5 * 60_000;
const TELEGRAM_LIMIT = 4_000;
const QUOTES_SHOWN = 2;
const QUEUE_LIMIT = 50;

const ACTIONS = {
  a: { step: 'ask', outcome: 'approve' },
  r: { step: 'ask', outcome: 'reject' },
  m: { step: 'ask', outcome: 'more_research' },
  ya: { step: 'confirm', outcome: 'approve' },
  yr: { step: 'confirm', outcome: 'reject' },
  ym: { step: 'confirm', outcome: 'more_research' },
  c: { step: 'cancel', outcome: undefined },
} as const;
type ActionCode = keyof typeof ACTIONS;

const OUTCOME_LABELS: Readonly<Record<ReviewOutcome, string>> = {
  approve: '✅ проверять',
  reject: '❌ не брать',
  more_research: '🔍 доисследовать',
};
const CONFIRM: Readonly<
  Record<
    ReviewOutcome,
    { readonly code: ActionCode; readonly button: string; readonly question: string }
  >
> = {
  approve: {
    code: 'ya',
    button: '✅ Да, проверять',
    question: 'Проверять «%»? Дальше система предложит 5 гипотез проверки.',
  },
  reject: {
    code: 'yr',
    button: '❌ Да, не брать',
    question: 'Не брать «%»? Возможность закроется.',
  },
  more_research: {
    code: 'ym',
    button: '🔍 Да, доисследовать',
    question: 'Отправить «%» на доисследование? Карточка вернётся, когда появятся новые сигналы.',
  },
};
const VERDICTS: Readonly<Record<ReviewOutcome, string>> = {
  approve: '✅ Решение: проверять. Дальше — 5 гипотез проверки (PHASE 14).',
  reject: '❌ Решение: не брать. Возможность закрыта.',
  more_research: '🔍 Решение: доисследовать. Карточка вернётся с новыми сигналами.',
};

/** Everything a card shows, read from the database. */
export interface CardData {
  readonly opportunity: Opportunity;
  readonly score?: OpportunityScore | undefined;
  readonly judgements: readonly StoredJudgement[];
  readonly panel: JudgePanel;
  readonly recommendation: Recommendation;
  readonly market?: MarketContextData | undefined;
  readonly evidence: readonly Evidence[];
  readonly sources: number;
}

type CardStore = {
  readonly repositories: Pick<Repositories, 'pains' | 'evidence' | 'knowledgeAssets'>;
  readonly judgements: Pick<JudgementLog, 'latest'>;
  readonly opportunityAssessments: Pick<OpportunityAssessmentLog, 'scores'>;
};

export async function loadCard(store: CardStore, opportunity: Opportunity): Promise<CardData> {
  const { repositories } = store;
  const pains = await repositories.pains.getByIds(opportunity.painIds);
  const evidence = [
    ...(await repositories.evidence.getByIds([
      ...new Set(pains.flatMap((pain) => pain.evidenceIds)),
    ])),
  ].sort((a, b) => timestampMs(b.observedAt) - timestampMs(a.observedAt));
  const judgements = (await store.judgements.latest([opportunity.id])).get(opportunity.id) ?? [];
  const scores: Partial<Record<JudgeCriterion, number>> = {};
  for (const item of judgements) {
    if (item.outcome === 'judged' && item.score !== undefined) scores[item.criterion] = item.score;
  }
  const panel = judgePanel(scores);
  const [entry] = await repositories.knowledgeAssets.listByTags([MARKET_CONTEXT_TAG], {
    opportunityIds: [opportunity.id],
    limit: 1,
  });
  return {
    opportunity,
    score: (await store.opportunityAssessments.scores([opportunity.id])).get(opportunity.id),
    judgements,
    panel,
    recommendation: recommendOpportunity(panel),
    market: entry === undefined ? undefined : readMarketContext(entry),
    evidence,
    sources: distinctSources(evidence).size,
  };
}

function reasonText(data: CardData): string {
  const { recommendation, panel } = data;
  const labels = (criteria: readonly JudgeCriterion[]) =>
    criteria.map((criterion) => CRITERION_LABELS[criterion]).join(', ');
  switch (recommendation.reason) {
    case 'incomplete':
      return `оценка неполная (нет: ${labels(panel.missing)})`;
    case 'critical_weakness':
      return `критический недостаток: ${labels(
        JUDGE_CRITERIA.filter((criterion) => panel.scores[criterion] === 1),
      )}`;
    case 'low_total':
      return `низкий итог судей (${String(panel.total)}/100)`;
    case 'strong':
      return 'сильная по всем пунктам';
    case 'mixed':
      return panel.weak.length === 0
        ? `итог ${String(panel.total)}/100 — ниже порога одобрения`
        : `слабые места: ${labels(panel.weak)}`;
  }
}

/** The text of a decision card; within one Telegram message. */
export function cardText(data: CardData): string {
  const { opportunity, score, market } = data;
  const model = opportunity.businessModel;
  const parts =
    score === undefined
      ? ''
      : Object.entries(PART_LABELS)
          .filter(([part]) => part in score.components)
          .map(([part, label]) => `${label} ${String(score.components[part])}`)
          .join(' · ');
  const weak = data.panel.weak.flatMap((criterion) => {
    const judgement = data.judgements.find((item) => item.criterion === criterion);
    const why = judgement?.concerns[0] ?? judgement?.rationale;
    return why === undefined ? [] : [`   – ${CRITERION_LABELS[criterion]}: ${shorten(why, 160)}`];
  });
  const quotes = data.evidence
    .slice(0, QUOTES_SHOWN)
    .map(
      (item) =>
        `• «${shorten(item.excerpt.replace(/\s+/g, ' '), 180)}»${item.url === undefined ? '' : ` ${item.url}`}`,
    );
  const marketText = market === undefined ? undefined : marketLine(market);
  const lines = [
    '💡 Возможность на решение',
    `«${opportunity.title}»`,
    `Клиент: ${shorten(opportunity.icp, 200)}`,
    `Проблема: ${shorten(opportunity.valueProposition.problem, 240)}`,
    `Изменение: ${shorten(opportunity.valueProposition.change, 240)}`,
    `Результат: ${shorten(opportunity.valueProposition.measurableResult, 160)}`,
    `Модель: ${MODEL_LABELS[model.model]}${
      model.pricingHypothesis === undefined ? '' : ` · ${shorten(model.pricingHypothesis, 120)}`
    }`,
    ...(score === undefined ? [] : [`Оценка: ${String(score.score)}/100 (${parts})`]),
    ...judgesLines(data.judgements).map((line) => line.trimStart()),
    ...weak,
    ...(marketText === undefined ? [] : [marketText.trimStart()]),
    `Доказательства: ${String(data.evidence.length)} из ${String(data.sources)} источн.`,
    ...quotes,
    '',
    `Рекомендация системы: ${OUTCOME_LABELS[data.recommendation.outcome]} — ${reasonText(data)}.`,
    'Решаете вы.',
  ];
  const text = lines.join('\n');
  return text.length <= TELEGRAM_LIMIT ? text : `${text.slice(0, TELEGRAM_LIMIT - 1)}…`;
}

function button(text: string, code: ActionCode, opportunity: Opportunity) {
  return callbackButton(
    text,
    `${OPPORTUNITY_PREFIX}:${code}:${opportunity.id}:${String(opportunity.version)}`,
  );
}

export function cardKeyboard(opportunity: Opportunity): InlineKeyboard {
  return [
    [button('✅ Проверять', 'a', opportunity), button('❌ Не брать', 'r', opportunity)],
    [button('🔍 Доисследовать', 'm', opportunity)],
  ];
}

/** The rationale the code records with the owner's decision: a lesson for similar cases. */
export function decisionRationale(data: CardData, outcome: ReviewOutcome): string {
  const { opportunity, panel, recommendation } = data;
  const scores = JUDGE_CRITERIA.map(
    (criterion) => `${criterion} ${String(panel.scores[criterion] ?? '-')}`,
  ).join(', ');
  return shorten(
    [
      `Owner decision: ${outcome}. Opportunity: ${opportunity.title}.`,
      `Judges ${panel.total === undefined ? 'incomplete' : `${String(panel.total)}/100`} (${scores})` +
        (panel.weak.length === 0 ? '.' : `; weak: ${panel.weak.join(', ')}.`),
      `System recommendation: ${recommendation.outcome} (${recommendation.reason}).`,
      `Customer: ${opportunity.icp}. Problem: ${opportunity.valueProposition.problem}.`,
      `Business model: ${opportunity.businessModel.model}.`,
    ].join(' '),
    3_000,
  );
}

export interface OpportunityFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
}

/** /decisions: the cards of opportunities under review, oldest first. */
export async function reviewQueue(
  repositories: Pick<Repositories, 'opportunities'>,
): Promise<Opportunity[]> {
  const queue = await repositories.opportunities.listByStatus('under_review', {
    limit: QUEUE_LIMIT,
  });
  return [...queue].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

export async function sendOpportunityCards(
  deps: OpportunityFlowDeps,
  queue: readonly Opportunity[],
  reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>,
): Promise<void> {
  for (const opportunity of queue.slice(0, MAX_OPPORTUNITY_CARDS)) {
    await reply(cardText(await loadCard(deps.database, opportunity)), cardKeyboard(opportunity));
  }
}

type DecideOutcome =
  | { readonly outcome: 'decided'; readonly decision: ReviewOutcome; readonly status: string }
  | { readonly outcome: 'closed'; readonly status: string }
  | { readonly outcome: 'not_found' };

const CLOSED_TEXT: Readonly<Record<string, string>> = {
  approved: '✅ Уже решено: проверять.',
  rejected: '❌ Уже решено: не брать.',
  draft: '🔍 Возможность на доисследовании.',
  archived: 'Возможность в архиве.',
};

function parse(data: string) {
  const [code, rawId, rawVersion] = data.split(':');
  const id = opportunityIdSchema.safeParse(rawId);
  const version = Number(rawVersion);
  if (
    code === undefined ||
    !Object.hasOwn(ACTIONS, code) ||
    !id.success ||
    !Number.isInteger(version)
  ) {
    return undefined;
  }
  return { action: ACTIONS[code as ActionCode], id: id.data, version };
}

/** Button handler of the cards: ask → confirm → decide, or back to the card. */
export async function handleOpportunityButton(
  deps: OpportunityFlowDeps,
  context: CallbackContext,
): Promise<void> {
  const parsed = parse(context.data);
  if (parsed === undefined) {
    await context.answer('Кнопка устарела');
    return;
  }
  const { action, id, version } = parsed;
  const { repositories } = deps.database;

  if (action.step !== 'confirm') {
    // Showing a question or the card again changes nothing: no confirmation needed.
    const opportunity = await repositories.opportunities.getById(id);
    if (opportunity === undefined) {
      await context.edit('Возможность не найдена.');
      return;
    }
    const data = await loadCard(deps.database, opportunity);
    if (opportunity.status !== 'under_review' || opportunity.version !== version) {
      await context.edit(`${cardText(data)}\n\n${closedText(opportunity.status)}`);
      return;
    }
    if (action.step === 'cancel') {
      await context.edit(cardText(data), cardKeyboard(opportunity));
      return;
    }
    const confirm = CONFIRM[action.outcome];
    await context.edit(
      `${cardText(data)}\n\n❓ ${confirm.question.replace('%', opportunity.title)}`,
      [[button(confirm.button, confirm.code, opportunity), button('Назад', 'c', opportunity)]],
    );
    return;
  }

  const actor = deps.owner(context.userId);
  let result: DecideOutcome;
  try {
    ({ result } = await deps.database.command(
      {
        name: 'opportunity.decide',
        idempotencyKey: `tg-callback-${context.callbackQueryId}`,
        correlationId: `tg-update-${context.updateId}`,
      },
      async (scope): Promise<DecideOutcome> => {
        const opportunity = await scope.repositories.opportunities.getById(id);
        if (opportunity === undefined) return { outcome: 'not_found' };
        if (opportunity.status !== 'under_review' || opportunity.version !== version) {
          return { outcome: 'closed', status: opportunity.status };
        }
        const data = await loadCard(scope, opportunity);
        const decision = createDecision(
          {
            subject: { type: 'opportunity', id: opportunity.id },
            outcome: action.outcome,
            rationale: decisionRationale(data, action.outcome),
            evidenceIds: data.evidence.slice(0, 100).map((item) => item.id),
          },
          { id: decisionIdSchema.parse(uuidv7()), actor, at: deps.now() },
        );
        await scope.repositories.decisions.insert(decision);
        const next = applyOpportunityDecision(opportunity, decision);
        await scope.repositories.opportunities.update(next, actor);
        return { outcome: 'decided', decision: action.outcome, status: next.status };
      },
    ));
  } catch (error) {
    if (!(error instanceof ConcurrencyError)) throw error;
    context.logger.warn('opportunity changed while it was being decided', { opportunity_id: id });
    result = { outcome: 'closed', status: 'changed' };
  }

  const opportunity = await repositories.opportunities.getById(id);
  if (result.outcome === 'not_found' || opportunity === undefined) {
    await context.edit('Возможность не найдена.');
    return;
  }
  const text = cardText(await loadCard(deps.database, opportunity));
  if (result.outcome === 'closed') {
    await context.edit(`${text}\n\n${closedText(result.status)}`);
    return;
  }
  context.logger.info('opportunity decided by the owner', {
    opportunity_id: id,
    decision: result.decision,
    status: result.status,
  });
  await context.edit(`${text}\n\n${VERDICTS[result.decision]}`);
  await context.answer('Решение записано');
}

function closedText(status: string): string {
  return (
    CLOSED_TEXT[status] ?? '⚠️ Карточка устарела: возможность изменилась. Откройте /decisions.'
  );
}

export interface DecisionCardNotifierOptions {
  readonly database: Database;
  readonly logger: Logger;
  /** Sends a card (or a notice, without buttons) to the owner; must throw when delivery fails. */
  readonly deliver: (text: string, keyboard?: InlineKeyboard) => Promise<void>;
  readonly intervalMs?: number | undefined;
  readonly now?: () => number;
  /** The api's public address, for the preview link of landing cards (PHASE 19a). */
  readonly publicApiUrl?: string | undefined;
}

export interface DecisionCardNotifier {
  start(): void;
  /** Sends every card not sent yet; returns how many were sent. */
  runOnce(): Promise<number>;
  stop(): Promise<void>;
}

/**
 * Sends each version of an opportunity under review to the owner once (PHASE 12): the card is
 * delivered inside an idempotent command (`decision-card-<id>-v<version>`), so a failed delivery
 * is retried and a delivered one never repeats; likewise one notice per approved opportunity
 * when its hypotheses are ready (PHASE 14) and one card per version of a draft landing (PHASE
 * 19a). The kill switch stops the sending; an automatic pause
 * by the spend guard is itself announced once (PHASE 16).
 */
export function createDecisionCardNotifier(
  options: DecisionCardNotifierOptions,
): DecisionCardNotifier {
  const { database, logger } = options;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? CARD_INTERVAL_MS;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = true;

  async function runOnce(): Promise<number> {
    const control = await database.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
    if (control === undefined)
      throw new Error('the automation kill switch is missing (migration 0003)');
    if (control.status === 'paused' && control.reason?.startsWith(AUTO_PAUSE_PREFIX) === true) {
      // The spend guard paused the system (PHASE 16): tell the owner once per pause, even now.
      const key = `auto-pause-v${String(control.version)}`;
      const { outcome } = await database.command(
        { name: 'economics.auto_pause_notice', idempotencyKey: key, correlationId: key },
        async () => {
          await options.deliver(`⛔ ${control.reason ?? ''}`);
          return { sentAt: toTimestamp(new Date(now())) };
        },
      );
      return outcome === 'executed' ? 1 : 0;
    }
    try {
      assertAutomationRunning(control);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'automation_paused') return 0;
      throw error;
    }
    let sent = 0;
    for (const opportunity of await reviewQueue(database.repositories)) {
      const key = `decision-card-${opportunity.id}-v${String(opportunity.version)}`;
      const { outcome } = await database.command(
        { name: 'decision.card', idempotencyKey: key, correlationId: key },
        async (scope) => {
          // Delivered inside the command: a failed delivery stores nothing and is retried.
          const current = await scope.repositories.opportunities.getById(opportunity.id);
          if (current?.status !== 'under_review' || current.version !== opportunity.version) {
            return { skipped: true };
          }
          await options.deliver(cardText(await loadCard(scope, current)), cardKeyboard(current));
          return { sentAt: toTimestamp(new Date(now())) };
        },
      );
      if (outcome === 'executed') sent += 1;
    }
    // PHASE 14: one notice per approved opportunity whose hypotheses are ready.
    const approved = await database.repositories.opportunities.listByStatus('approved', {
      limit: QUEUE_LIMIT,
    });
    const hypotheses = await database.repositories.hypotheses.listByOpportunities(
      approved.map((item) => item.id),
    );
    for (const opportunity of approved) {
      const count = hypotheses.filter((item) => item.opportunityId === opportunity.id).length;
      if (count === 0) continue;
      const key = `hypotheses-ready-${opportunity.id}`;
      const { outcome } = await database.command(
        { name: 'hypotheses.notice', idempotencyKey: key, correlationId: key },
        async () => {
          await options.deliver(hypothesesReadyText(opportunity, count));
          return { sentAt: toTimestamp(new Date(now())) };
        },
      );
      if (outcome === 'executed') sent += 1;
    }
    // PHASE 19a: one card per version of a draft landing, with ✅ / ❌.
    const drafts = await database.repositories.mediaAssets.listByStatus('draft', {
      limit: QUEUE_LIMIT,
    });
    const views = drafts.length === 0 ? [] : await activeExperimentViews(database);
    for (const asset of drafts) {
      const key = `landing-card-${asset.id}-v${String(asset.version)}`;
      const number = views.find((view) => view.experiment.id === asset.experimentId)?.number;
      const { outcome } = await database.command(
        { name: 'media.card', idempotencyKey: key, correlationId: key },
        async (scope) => {
          const current = await scope.repositories.mediaAssets.getById(asset.id);
          if (current?.status !== 'draft' || current.version !== asset.version) {
            return { skipped: true };
          }
          const context = await landingCardContext(scope.repositories, current, number);
          await options.deliver(
            landingCardText(current, { ...context, publicApiUrl: options.publicApiUrl }),
            landingKeyboard(current),
          );
          return { sentAt: toTimestamp(new Date(now())) };
        },
      );
      if (outcome === 'executed') sent += 1;
    }
    // PHASE 20: one notice per new lead; the email stays in /leads.
    const fresh = await database.repositories.leads.listByStatus('new', { limit: QUEUE_LIMIT });
    const leadViews =
      fresh.length === 0 ? [] : views.length > 0 ? views : await activeExperimentViews(database);
    for (const lead of fresh) {
      const key = `lead-notice-${lead.id}`;
      const view = leadViews.find((item) => item.experiment.id === lead.experimentId);
      const { outcome } = await database.command(
        { name: 'lead.notice', idempotencyKey: key, correlationId: key },
        async () => {
          await options.deliver(
            newLeadText(lead, { number: view?.number, title: view?.opportunity.title ?? 'тест' }),
          );
          return { sentAt: toTimestamp(new Date(now())) };
        },
      );
      if (outcome === 'executed') sent += 1;
    }
    if (sent > 0) logger.info('decision cards sent', { sent });
    return sent;
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      running = runOnce()
        .catch((error: unknown) => {
          logger.error('decision cards not sent', { error });
        })
        .finally(() => {
          running = undefined;
          schedule(intervalMs);
        });
    }, delayMs);
    timer.unref();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    runOnce,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}

/** How many opportunities wait for the owner's decision, for the digest. */
export async function reviewCount(
  repositories: Pick<Repositories, 'opportunities'>,
): Promise<number> {
  return (await reviewQueue(repositories)).length;
}
