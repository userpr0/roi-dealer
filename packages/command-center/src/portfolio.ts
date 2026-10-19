import {
  applyOpportunityDecision,
  createDecision,
  decisionIdSchema,
  formatUsd,
  opportunityIdSchema,
  sumMoney,
  type Actor,
  type Experiment,
  type Opportunity,
  type Timestamp,
} from '@roi-dealer/domain';
import { ConcurrencyError, type Database } from '@roi-dealer/database';
import { uuidv7 } from '@roi-dealer/shared';
import { callbackButton, type CallbackContext, type InlineKeyboard } from '@roi-dealer/telegram';
import { shorten } from './texts.js';

/*
 * /portfolio (PHASE 13): the opportunities the owner approved and has not closed — their tests
 * and money — with ⏸ pause, ▶️ resume and ⛔ close. A press asks for confirmation, then one
 * idempotent owner command records the Decision and applies it (as on the PHASE 12 card).
 */

/** Buttons of portfolio cards: `pf:<action>:<opportunity id>:<version>`. */
export const PORTFOLIO_PREFIX = 'pf';
export const MAX_PORTFOLIO_CARDS = 10;
const IN_WORK = ['approved', 'validating', 'scaling', 'paused'] as const;
const OPEN_TESTS = ['planned', 'awaiting_approval', 'approved', 'running', 'stopped'] as const;

const STATUS_LABELS: Readonly<Record<string, string>> = {
  approved: '✅ одобрена',
  validating: '🧪 на проверке',
  scaling: '🚀 масштабирование',
  paused: '⏸ на паузе',
  killed: '⛔ закрыта',
};

/** `pause`, `improve` (back to validation) and `kill` from the portfolio. */
const ACTIONS = {
  p: { outcome: 'pause', question: '⏸ Поставить «%» на паузу?', button: '⏸ Да, пауза' },
  r: {
    outcome: 'improve',
    question: '▶️ Продолжить проверку «%»? Возможность снова будет на проверке.',
    button: '▶️ Да, продолжить',
  },
  k: {
    outcome: 'kill',
    question: '⛔ Закрыть «%»? Это окончательно: гипотезы и тесты по ней больше не запускаются.',
    button: '⛔ Да, закрыть',
  },
} as const;
type ActionCode = keyof typeof ACTIONS;

export interface PortfolioDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
}

interface PortfolioCard {
  readonly opportunity: Opportunity;
  readonly open: number;
  readonly completed: number;
  readonly text: string;
}

async function experimentsOf(database: Database, opportunity: Opportunity): Promise<Experiment[]> {
  const all: Experiment[] = [];
  for (const status of [...OPEN_TESTS, 'completed'] as const) {
    all.push(
      ...(await database.repositories.experiments.listByStatus(status, { limit: 1_000 })).filter(
        (item) => item.opportunityId === opportunity.id,
      ),
    );
  }
  return all;
}

async function cardOf(database: Database, opportunity: Opportunity): Promise<PortfolioCard> {
  const experiments = await experimentsOf(database, opportunity);
  const open = experiments.filter((item) =>
    (OPEN_TESTS as readonly string[]).includes(item.status),
  ).length;
  const completed = experiments.length - open;
  const flows = [
    ...(await database.economics.moneyFlows(experiments.map((item) => item.id))).values(),
  ];
  const revenue = sumMoney(flows.flatMap((flow) => [flow.payments, flow.preorders]));
  const customers = flows.reduce((sum, flow) => sum + flow.customers, 0);
  const spend = sumMoney(flows.map((flow) => flow.spend));
  const text = [
    `💼 «${shorten(opportunity.title, 120)}» · ${STATUS_LABELS[opportunity.status] ?? opportunity.status}`,
    `Тесты: идут ${String(open)}, завершены ${String(completed)} · траты ${formatUsd(spend)} · выручка ${formatUsd(revenue)} · клиентов ${String(customers)}`,
  ].join('\n');
  return { opportunity, open, completed, text };
}

function button(text: string, action: string, opportunity: Opportunity) {
  return callbackButton(
    text,
    `${PORTFOLIO_PREFIX}:${action}:${opportunity.id}:${String(opportunity.version)}`,
  );
}

export function portfolioKeyboard(opportunity: Opportunity): InlineKeyboard | undefined {
  const close = button('⛔ Закрыть', 'k', opportunity);
  if (opportunity.status === 'paused') return [[button('▶️ Продолжить', 'r', opportunity), close]];
  if ((IN_WORK as readonly string[]).includes(opportunity.status)) {
    return [[button('⏸ Пауза', 'p', opportunity), close]];
  }
  return undefined;
}

/** /portfolio: one card per opportunity in work, most recently changed first. */
export async function sendPortfolio(
  deps: PortfolioDeps,
  reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>,
): Promise<void> {
  const inWork: Opportunity[] = [];
  for (const status of IN_WORK) {
    inWork.push(
      ...(await deps.database.repositories.opportunities.listByStatus(status, { limit: 1_000 })),
    );
  }
  if (inWork.length === 0) {
    await reply(
      '💼 Возможностей в работе нет.\n\nОни появляются, когда вы одобряете возможность в /decisions.',
    );
    return;
  }
  const shown = [...inWork]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_PORTFOLIO_CARDS);
  await reply(
    `💼 Возможности в работе: ${String(inWork.length)}` +
      (inWork.length > shown.length ? ` · показаны ${String(shown.length)} последних` : '') +
      '\n⏸ пауза и ⛔ закрытие — когда у возможности нет незавершённых тестов (/experiments).',
  );
  for (const opportunity of shown) {
    const card = await cardOf(deps.database, opportunity);
    await reply(card.text, portfolioKeyboard(opportunity));
  }
}

type PortfolioOutcome =
  | { readonly outcome: 'decided'; readonly status: string }
  | { readonly outcome: 'closed'; readonly text: string }
  | { readonly outcome: 'not_found' };

const STALE_TEXT = '⚠️ Карточка устарела: возможность изменилась. Откройте /portfolio.';

/** Button handler: ask → confirm → one owner command, or back to the card. */
export async function handlePortfolioButton(
  deps: PortfolioDeps,
  context: CallbackContext,
): Promise<void> {
  const [code, rawId, rawVersion] = context.data.split(':');
  const id = opportunityIdSchema.safeParse(rawId);
  const version = Number(rawVersion);
  const confirm = code?.startsWith('y') === true;
  const actionCode = (confirm ? code.slice(1) : code) ?? '';
  const valid = Object.hasOwn(ACTIONS, actionCode) || (!confirm && actionCode === 'c');
  if (!valid || !id.success || !Number.isSafeInteger(version)) {
    await context.answer('Кнопка устарела');
    return;
  }
  const { repositories } = deps.database;

  if (!confirm) {
    const opportunity = await repositories.opportunities.getById(id.data);
    if (opportunity === undefined) {
      await context.edit('Возможность не найдена.');
      return;
    }
    const card = await cardOf(deps.database, opportunity);
    if (actionCode === 'c' || opportunity.version !== version) {
      await context.edit(
        opportunity.version === version ? card.text : `${card.text}\n\n${STALE_TEXT}`,
        portfolioKeyboard(opportunity),
      );
      return;
    }
    const action = ACTIONS[actionCode as ActionCode];
    await context.edit(`${card.text}\n\n❓ ${action.question.replace('%', opportunity.title)}`, [
      [button(action.button, `y${actionCode}`, opportunity), button('Назад', 'c', opportunity)],
    ]);
    return;
  }

  const action = ACTIONS[actionCode as ActionCode];
  const actor = deps.owner(context.userId);
  let result: PortfolioOutcome;
  try {
    ({ result } = await deps.database.command(
      {
        name: 'opportunity.portfolio',
        idempotencyKey: `tg-callback-${context.callbackQueryId}`,
        correlationId: `tg-update-${context.updateId}`,
      },
      async (scope): Promise<PortfolioOutcome> => {
        const opportunity = await scope.repositories.opportunities.getById(id.data);
        if (opportunity === undefined) return { outcome: 'not_found' };
        if (opportunity.version !== version) return { outcome: 'closed', text: STALE_TEXT };
        const allowed =
          action.outcome === 'improve'
            ? opportunity.status === 'paused'
            : (IN_WORK as readonly string[]).includes(opportunity.status) &&
              !(action.outcome === 'pause' && opportunity.status === 'paused');
        if (!allowed) return { outcome: 'closed', text: STALE_TEXT };
        if (action.outcome !== 'improve') {
          const [row] = await scope.sql<{ count: string }[]>`
            select count(*)::text as count from experiments
            where opportunity_id = ${opportunity.id}
              and status in ('planned', 'awaiting_approval', 'approved', 'running', 'stopped')
          `;
          const open = Number(row?.count ?? 0);
          if (open > 0) {
            return {
              outcome: 'closed',
              text: `⛔ Сначала завершите или отмените незавершённые тесты: ${String(open)} (/experiments).`,
            };
          }
        }
        const decision = createDecision(
          {
            subject: { type: 'opportunity', id: opportunity.id },
            outcome: action.outcome,
            rationale: `Owner decision from the portfolio: ${action.outcome}.`,
            evidenceIds: [],
          },
          { id: decisionIdSchema.parse(uuidv7()), actor, at: deps.now() },
        );
        await scope.repositories.decisions.insert(decision);
        const next = applyOpportunityDecision(opportunity, decision);
        await scope.repositories.opportunities.update(next, actor);
        return { outcome: 'decided', status: next.status };
      },
    ));
  } catch (error) {
    if (!(error instanceof ConcurrencyError)) throw error;
    result = { outcome: 'closed', text: STALE_TEXT };
  }

  const opportunity = await repositories.opportunities.getById(id.data);
  if (result.outcome === 'not_found' || opportunity === undefined) {
    await context.edit('Возможность не найдена.');
    return;
  }
  const card = await cardOf(deps.database, opportunity);
  if (result.outcome === 'closed') {
    await context.edit(`${card.text}\n\n${result.text}`, portfolioKeyboard(opportunity));
    return;
  }
  context.logger.info('opportunity changed from the portfolio', {
    opportunity_id: opportunity.id,
    status: result.status,
  });
  await context.edit(
    `${card.text}\n\n✅ Решение записано: ${STATUS_LABELS[result.status] ?? result.status}.`,
    portfolioKeyboard(opportunity),
  );
  await context.answer('Решение записано');
}
