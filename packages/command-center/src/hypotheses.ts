import {
  changeHypothesisStatus,
  createExperiment,
  DomainError,
  experimentIdSchema,
  formatUsd,
  hypothesisIdSchema,
  planExperiment,
  type Actor,
  type Hypothesis,
  type HypothesisStatus,
  type Opportunity,
  type Timestamp,
} from '@roi-dealer/domain';
import { ConcurrencyError, type Database, type Repositories } from '@roi-dealer/database';
import { uuidv7 } from '@roi-dealer/shared';
import { callbackButton, type CallbackContext, type InlineKeyboard } from '@roi-dealer/telegram';
import { ARTIFACT_LABELS, METHOD_LABELS, metricText } from './experiments.js';
import { shorten } from './texts.js';

/** At most this many opportunities are listed in /hypotheses. */
export const HYPOTHESES_SHOWN = 5;
/** Buttons that pick a hypothesis to test (PHASE 15): `hy:<action>:<hypothesis id>:<version>`. */
export const HYPOTHESIS_PREFIX = 'hy';

const STATUS_LABELS: Readonly<Record<HypothesisStatus, string>> = {
  proposed: 'предложена',
  selected: 'выбрана для теста',
  discarded: 'отброшена',
  testing: 'проверяется',
  confirmed: 'подтверждена',
  refuted: 'опровергнута',
  inconclusive: 'без вывода',
};
/** Opportunities whose hypotheses can be tested. */
const OPEN_STATUSES = ['approved', 'validating', 'scaling'] as const;

export const NO_HYPOTHESES_TEXT =
  '🧪 Гипотез пока нет.\n\nОни появляются, когда вы одобряете возможность (✅ Проверять в ' +
  '/decisions): агент гипотез предлагает пять разных способов её проверить.';

function hypothesisLines(hypothesis: Hypothesis, index: number): string[] {
  return [
    `${String(index + 1)}. ${METHOD_LABELS[hypothesis.validationMethod]} · ${shorten(hypothesis.audience, 80)} (${hypothesis.geo}) · ${formatUsd(hypothesis.price)} · канал: ${shorten(hypothesis.channel, 60)}` +
      (hypothesis.status === 'proposed' ? '' : ` · ${STATUS_LABELS[hypothesis.status]}`),
    `   Бюджет ${formatUsd(hypothesis.budget)}, stop-loss ${formatUsd(hypothesis.stopLoss)} · успех: ${metricText(hypothesis.successMetric)}`,
    `   ${shorten(hypothesis.statement, 240)}`,
  ];
}

export interface HypothesisCard {
  readonly text: string;
  readonly keyboard?: InlineKeyboard | undefined;
}

function opportunityCard(opportunity: Opportunity, own: readonly Hypothesis[]): HypothesisCard {
  const lines = [
    `«${opportunity.title}» — ${own.length === 0 ? 'гипотезы готовятся' : `гипотез ${String(own.length)}`}`,
  ];
  for (const [index, hypothesis] of own.entries())
    lines.push(...hypothesisLines(hypothesis, index));
  const buttons = own.flatMap((hypothesis, index) =>
    hypothesis.status === 'proposed'
      ? [callbackButton(`🧪 ${String(index + 1)}`, buttonData('t', hypothesis))]
      : [],
  );
  return { text: lines.join('\n'), keyboard: buttons.length === 0 ? undefined : [buttons] };
}

function buttonData(action: string, hypothesis: Hypothesis): string {
  return `${HYPOTHESIS_PREFIX}:${action}:${hypothesis.id}:${String(hypothesis.version)}`;
}

/**
 * /hypotheses (PHASE 14): approved opportunities and their five hypotheses — method, audience
 * and GEO, price, channel, budget and stop-loss, success metric; from the database only. A
 * proposed hypothesis has a 🧪 button that plans its test (PHASE 15).
 */
export async function hypothesisCards(
  repositories: Pick<Repositories, 'opportunities' | 'hypotheses'>,
): Promise<{ readonly header: string; readonly cards: HypothesisCard[] } | undefined> {
  const open: Opportunity[] = [];
  for (const status of OPEN_STATUSES) {
    open.push(...(await repositories.opportunities.listByStatus(status, { limit: 1_000 })));
  }
  const shown = [...open]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, HYPOTHESES_SHOWN);
  const hypotheses = await repositories.hypotheses.listByOpportunities(
    shown.map((item) => item.id),
  );
  if (hypotheses.length === 0) return undefined;
  return {
    header:
      `🧪 Гипотезы · возможностей: ${String(shown.length)}\n` +
      '🧪 N — проверить гипотезу N: план теста, чек-лист честной проверки и запуск с вашего ' +
      'одобрения → /experiments.',
    cards: shown.map((opportunity) =>
      opportunityCard(
        opportunity,
        hypotheses.filter((item) => item.opportunityId === opportunity.id),
      ),
    ),
  };
}

/** The whole of /hypotheses as one text (the digest and tests read it this way). */
export async function hypothesesText(
  repositories: Pick<Repositories, 'opportunities' | 'hypotheses'>,
): Promise<string> {
  const cards = await hypothesisCards(repositories);
  if (cards === undefined) return NO_HYPOTHESES_TEXT;
  return [cards.header, ...cards.cards.map((card) => card.text)].join('\n\n');
}

export async function sendHypotheses(
  repositories: Pick<Repositories, 'opportunities' | 'hypotheses'>,
  reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>,
): Promise<void> {
  const cards = await hypothesisCards(repositories);
  if (cards === undefined) {
    await reply(NO_HYPOTHESES_TEXT);
    return;
  }
  await reply(cards.header);
  for (const card of cards.cards) await reply(card.text, card.keyboard);
}

/** The one notice per opportunity that its hypotheses are ready. */
export function hypothesesReadyText(opportunity: Opportunity, count: number): string {
  return `🧪 Готовы ${String(count)} гипотез проверки для «${opportunity.title}» → /hypotheses`;
}

export interface HypothesisFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
}

type SelectOutcome =
  | { readonly outcome: 'selected'; readonly experimentId: string }
  | { readonly outcome: 'closed'; readonly text: string }
  | { readonly outcome: 'not_found' };

const STALE_TEXT = '⚠️ Карточка устарела. Откройте /hypotheses.';

async function cardOf(database: Database, hypothesis: Hypothesis): Promise<HypothesisCard> {
  const opportunity = await database.repositories.opportunities.getById(hypothesis.opportunityId);
  if (opportunity === undefined) return { text: 'Возможность не найдена.' };
  const own = await database.repositories.hypotheses.listByOpportunities([opportunity.id]);
  return opportunityCard(opportunity, own);
}

/**
 * The 🧪 button (PHASE 15): ask → confirm → one owner command selects the hypothesis and plans
 * its experiment (`planExperiment`); the checklist and the launch follow in /experiments.
 */
export async function handleHypothesisButton(
  deps: HypothesisFlowDeps,
  context: CallbackContext,
): Promise<void> {
  const [action, rawId, rawVersion] = context.data.split(':');
  const id = hypothesisIdSchema.safeParse(rawId);
  const version = Number(rawVersion);
  if (!['t', 'yt', 'c'].includes(action ?? '') || !id.success || !Number.isSafeInteger(version)) {
    await context.answer('Кнопка устарела');
    return;
  }
  const { repositories } = deps.database;

  if (action !== 'yt') {
    const hypothesis = await repositories.hypotheses.getById(id.data);
    if (hypothesis === undefined) {
      await context.edit('Гипотеза не найдена.');
      return;
    }
    const card = await cardOf(deps.database, hypothesis);
    if (action === 'c' || hypothesis.version !== version || hypothesis.status !== 'proposed') {
      await context.edit(
        hypothesis.version === version || action === 'c'
          ? card.text
          : `${card.text}\n\n${STALE_TEXT}`,
        card.keyboard,
      );
      return;
    }
    let plan: string;
    try {
      const experiment = planExperiment(hypothesis);
      plan =
        `План: ${ARTIFACT_LABELS[experiment.artifact]} · срок ${String(experiment.buildBudget.maxCalendarDays)} дней · ` +
        `бюджет ${formatUsd(experiment.testBudget)}, stop-loss ${formatUsd(experiment.stopLoss)} · ` +
        `успех: ${metricText(experiment.successMetric)}.`;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      await context.edit(`${card.text}\n\n⛔ Метрику этой гипотезы нельзя посчитать по воронке.`);
      return;
    }
    const own = await repositories.hypotheses.listByOpportunities([hypothesis.opportunityId]);
    const number = own.findIndex((item) => item.id === hypothesis.id) + 1;
    await context.edit(
      `${card.text}\n\n❓ Проверить гипотезу ${String(number)}? ${plan}\nЗатем в /experiments — ` +
        'чек-лист честной проверки и запрос запуска.',
      [
        [
          callbackButton('🧪 Да, проверить', buttonData('yt', hypothesis)),
          callbackButton('Назад', buttonData('c', hypothesis)),
        ],
      ],
    );
    return;
  }

  const actor = deps.owner(context.userId);
  let result: SelectOutcome;
  try {
    ({ result } = await deps.database.command(
      {
        name: 'hypothesis.select',
        idempotencyKey: `tg-callback-${context.callbackQueryId}`,
        correlationId: `tg-update-${context.updateId}`,
      },
      async (scope): Promise<SelectOutcome> => {
        const hypothesis = await scope.repositories.hypotheses.getById(id.data);
        if (hypothesis === undefined) return { outcome: 'not_found' };
        if (hypothesis.version !== version || hypothesis.status !== 'proposed') {
          return { outcome: 'closed', text: STALE_TEXT };
        }
        const opportunity = await scope.repositories.opportunities.getById(
          hypothesis.opportunityId,
        );
        if (
          opportunity === undefined ||
          !(OPEN_STATUSES as readonly string[]).includes(opportunity.status)
        ) {
          return { outcome: 'closed', text: '⛔ Возможность закрыта — гипотезы не проверяются.' };
        }
        const at = deps.now();
        const selected = changeHypothesisStatus(hypothesis, 'selected', { actor, at });
        let plan;
        try {
          plan = planExperiment(selected);
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          return {
            outcome: 'closed',
            text: '⛔ Метрику этой гипотезы нельзя посчитать по воронке.',
          };
        }
        await scope.repositories.hypotheses.update(selected, actor);
        const experiment = createExperiment(plan, selected, {
          id: experimentIdSchema.parse(uuidv7()),
          actor,
          at,
        });
        await scope.repositories.experiments.insert(experiment);
        return { outcome: 'selected', experimentId: experiment.id };
      },
    ));
  } catch (error) {
    if (!(error instanceof ConcurrencyError)) throw error;
    result = { outcome: 'closed', text: STALE_TEXT };
  }

  const hypothesis = await repositories.hypotheses.getById(id.data);
  if (result.outcome === 'not_found' || hypothesis === undefined) {
    await context.edit('Гипотеза не найдена.');
    return;
  }
  const card = await cardOf(deps.database, hypothesis);
  if (result.outcome === 'closed') {
    await context.edit(`${card.text}\n\n${result.text}`, card.keyboard);
    return;
  }
  context.logger.info('hypothesis selected for a test by the owner', {
    hypothesis_id: hypothesis.id,
    experiment_id: result.experimentId,
  });
  await context.edit(
    `${card.text}\n\n🧪 Тест запланирован. Дальше — /experiments: чек-лист честной проверки и запуск.`,
    card.keyboard,
  );
  await context.answer('Тест запланирован');
}
