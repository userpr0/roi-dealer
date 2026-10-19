import { randomBytes } from 'node:crypto';
import {
  addMoney,
  applyOpportunityDecision,
  approveExperiment,
  automaticStopReason,
  cancelApprovalRequest,
  cancelExperiment,
  changeHypothesisStatus,
  compareMoney,
  completeExperiment,
  confirmHonestChecks,
  costEntryIdSchema,
  createApprovalRequest,
  createDecision,
  createKnowledgeAsset,
  decisionIdSchema,
  DomainError,
  EXPERIMENT_OUTCOMES,
  experimentDay,
  experimentIdSchema,
  experimentTotalBudget,
  expireApprovalRequest,
  formatUsd,
  FUNNEL_STAGES,
  honestChecklist,
  hypothesisVerdict,
  isApprovalExpired,
  knowledgeAssetIdSchema,
  metricReached,
  metricValue,
  readFunnelMeasure,
  recordExperimentCost,
  requestExperimentApproval,
  returnExperimentToPlanning,
  startExperiment,
  startOpportunityValidation,
  STOP_REASONS,
  stopExperiment,
  timestampMs,
  toTimestamp,
  usd,
  ZERO_USD,
  approvalRequestIdSchema,
  type Actor,
  type ApprovalRequest,
  type Experiment,
  type ExperimentResult,
  type ExperimentStatus,
  type FunnelStage,
  type FunnelTotals,
  type HonestCheck,
  type Hypothesis,
  type Metric,
  type Money,
  type Opportunity,
  type Timestamp,
} from '@roi-dealer/domain';
import {
  ConcurrencyError,
  type Database,
  type Repositories,
  type TransactionScope,
} from '@roi-dealer/database';
import { uuidv7 } from '@roi-dealer/shared';
import {
  callbackButton,
  type CallbackContext,
  type CommandContext,
  type InlineKeyboard,
} from '@roi-dealer/telegram';
import { formatTime, shorten } from './texts.js';

/*
 * Experiment Engine in the panel (PHASE 15): the owner runs each test with buttons — the
 * honest-test checklist and the launch request, the start, the stop and the result — and
 * reports funnel numbers and spend with /funnel. Every change asks for confirmation and runs
 * as one idempotent owner command; the metric and the stop-loss are computed in code (§7.3).
 */

/** Buttons of experiment cards: `ex:<action>:<experiment id>:<version>`. */
export const EXPERIMENT_PREFIX = 'ex';
/** Buttons of /funnel confirmations: `fn:<y|n>:<nonce>`. */
export const FUNNEL_PREFIX = 'fn';
/** Experiment cards per /experiments reply. */
export const MAX_EXPERIMENT_CARDS = 10;
/** How long a launch request waits in /decisions. */
export const LAUNCH_REQUEST_DAYS = 7;
/** The most money one /funnel report may add. */
export const MAX_REPORTED_SPEND_USD = 10_000;
const CONFIRMATION_TTL_MS = 10 * 60_000;
const MAX_PENDING = 50;
const ACTIVE_STATUSES = ['planned', 'awaiting_approval', 'approved', 'running', 'stopped'] as const;
const DAY_MS = 86_400_000;

type ExperimentOutcome = ExperimentResult['outcome'];

export const STAGE_LABELS: Readonly<Record<FunnelStage, string>> = {
  impression: 'показы',
  attention: 'внимание',
  cta_click: 'клики CTA',
  activation: 'активации',
  lead: 'заявки',
  payment: 'оплаты',
  product_use: 'использование',
  outcome: 'результат',
  retention: 'возвраты',
};

/** Words /funnel understands for each stage: the Russian label's first word and English keys. */
const STAGE_WORDS: Readonly<Record<string, FunnelStage>> = {
  показы: 'impression',
  impression: 'impression',
  impressions: 'impression',
  внимание: 'attention',
  attention: 'attention',
  клики: 'cta_click',
  click: 'cta_click',
  clicks: 'cta_click',
  cta_click: 'cta_click',
  активации: 'activation',
  activation: 'activation',
  activations: 'activation',
  заявки: 'lead',
  lead: 'lead',
  leads: 'lead',
  trial: 'lead',
  trials: 'lead',
  оплаты: 'payment',
  payment: 'payment',
  payments: 'payment',
  использование: 'product_use',
  product_use: 'product_use',
  use: 'product_use',
  результат: 'outcome',
  outcome: 'outcome',
  outcomes: 'outcome',
  возвраты: 'retention',
  retention: 'retention',
};
const SPEND_WORDS = new Set(['потрачено', 'spent', 'spend']);

export const METHOD_LABELS: Readonly<Record<Hypothesis['validationMethod'], string>> = {
  landing_page: 'лендинг',
  demo: 'демо',
  clickable_prototype: 'прототип',
  concierge: 'вручную (concierge)',
  preorder: 'предзаказ',
  ads_test: 'реклама',
  outreach: 'прямые сообщения',
  interviews: 'интервью',
  marketplace_listing: 'маркетплейс',
  waitlist: 'лист ожидания',
  other: 'другое',
};

export const ARTIFACT_LABELS: Readonly<Record<Experiment['artifact'], string>> = {
  landing: 'лендинг',
  demo: 'демо',
  clickable_prototype: 'прототип',
  single_function_app: 'приложение одной функции',
  concierge: 'вручную (concierge)',
  minimal_automation: 'минимальная автоматизация',
  other: 'без сборки',
};

export const CHECK_LABELS: Readonly<Record<HonestCheck, string>> = {
  no_fabrication: 'Нет выдуманных отзывов, цифр и результатов; обещанный результат подтверждён',
  channel_rules:
    'Правила площадки и канала проверены: запрещённые категории, требования, формулировки',
  funnel_tracking: 'Цифры воронки есть откуда взять (UTM-метки, счётчики площадки) для /funnel',
  fake_door_disclosed: 'Если продукта ещё нет — прямо сказано «скоро» или «лист ожидания»',
  page_legal:
    'На странице: политика конфиденциальности, условия, согласие на рассылку (CAN-SPAM, GDPR), контакт',
  outreach_rules: 'Сообщения: настоящий отправитель, способ отписаться, без купленных баз',
  refund_terms: 'До оплаты указаны дата, условия и простой возврат; не сделаем — вернём деньги',
  payment_tested: 'Оплата и возврат проверены тестовым платежом',
  crash_test: '2–3 человека прошли демо или прототип без подсказок',
};

const STATUS_LABELS: Readonly<Record<ExperimentStatus, string>> = {
  planned: '📝 план',
  awaiting_approval: '⏳ ждёт ✅ в /decisions',
  approved: '✅ запуск одобрен',
  running: '▶️ идёт',
  stopped: '⏹ остановлен',
  completed: '🏁 завершён',
  cancelled: '✖️ отменён',
};

const STOP_LABELS: Readonly<Record<string, string>> = {
  [STOP_REASONS.stopLoss]: 'сработал stop-loss',
  [STOP_REASONS.budget]: 'бюджет израсходован',
  [STOP_REASONS.owner]: 'остановлен вами',
};

const OUTCOMES: Readonly<
  Record<ExperimentOutcome, { label: string; ask: string; confirm: string; consequence: string }>
> = {
  scale: {
    label: '🚀 Масштабировать',
    ask: 'qs',
    confirm: 'rs',
    consequence: 'Возможность перейдёт в масштабирование.',
  },
  improve: {
    label: '🔧 Улучшить',
    ask: 'qi',
    confirm: 'ri',
    consequence:
      'Возможность остаётся на проверке: повторите тест с улучшениями или выберите другую гипотезу.',
  },
  pivot: {
    label: '↪️ Сменить подход',
    ask: 'qp',
    confirm: 'rp',
    consequence: 'Подход закрыт; возможность остаётся на проверке — выберите другую гипотезу.',
  },
  kill: {
    label: '🛑 Закрыть возможность',
    ask: 'qk',
    confirm: 'rk',
    consequence: 'Возможность будет закрыта.',
  },
};

const VERDICT_LABELS = {
  confirmed: 'подтверждена',
  refuted: 'опровергнута',
  inconclusive: 'без вывода',
} as const;

/** Knowledge left by a result (§2.9): a pattern to repeat or a failure pattern to avoid. */
const ASSET_KIND = {
  scale: 'pattern',
  improve: 'knowledge',
  pivot: 'failure_pattern',
  kill: 'failure_pattern',
} as const;

const ASK_ACTIONS = { p: 'launch', x: 'cancel', g: 'go', s: 'stop' } as const;
const CONFIRM_ACTIONS = { yp: 'launch', yx: 'cancel', yg: 'go', ys: 'stop' } as const;
type Step = (typeof ASK_ACTIONS)[keyof typeof ASK_ACTIONS];

export function metricText(metric: Metric): string {
  const measure = readFunnelMeasure(metric);
  if (measure === undefined) {
    return `${shorten(metric.name, 60)} ${metric.direction === 'at_least' ? '≥' : '≤'} ${String(metric.target)} ${shorten(metric.unit, 20)}`;
  }
  return measure.per === undefined
    ? `${STAGE_LABELS[measure.stage]} ≥ ${String(metric.target)}`
    : `${STAGE_LABELS[measure.stage]} / ${STAGE_LABELS[measure.per]} ≥ ${String(metric.target)} %`;
}

function valueText(metric: Metric, value: number | undefined): string {
  if (value === undefined) return '—';
  return metric.unit === '%' ? `${String(value)} %` : String(value);
}

function funnelLine(totals: FunnelTotals): string {
  const parts = FUNNEL_STAGES.filter((stage) => (totals[stage] ?? 0) > 0).map(
    (stage) => `${STAGE_LABELS[stage]} ${String(totals[stage])}`,
  );
  return parts.length === 0 ? 'данных пока нет' : parts.join(' → ');
}

export interface ExperimentView {
  /** The number in /experiments and /funnel. */
  readonly number: number;
  readonly experiment: Experiment;
  readonly hypothesis: Hypothesis;
  readonly opportunity: Opportunity;
  readonly totals: FunnelTotals;
  readonly spent: Money;
  readonly request?: ApprovalRequest | undefined;
}

type Scope = Pick<TransactionScope, 'repositories' | 'funnel'>;

/** Experiments not completed or cancelled, oldest first: their numbers in /experiments. */
async function activeExperiments(repositories: Repositories): Promise<Experiment[]> {
  const all: Experiment[] = [];
  for (const status of ACTIVE_STATUSES) {
    all.push(...(await repositories.experiments.listByStatus(status, { limit: 1_000 })));
  }
  return all.sort(
    (a, b) => timestampMs(a.createdAt) - timestampMs(b.createdAt) || a.id.localeCompare(b.id),
  );
}

async function viewsOf(
  scope: Scope,
  experiments: readonly Experiment[],
): Promise<ExperimentView[]> {
  const { repositories, funnel } = scope;
  const ids = experiments.map((item) => item.id);
  const hypotheses = new Map(
    (await repositories.hypotheses.getByIds(experiments.map((item) => item.hypothesisId))).map(
      (item) => [item.id, item],
    ),
  );
  const opportunities = new Map(
    (
      await repositories.opportunities.getByIds([
        ...new Set(experiments.map((item) => item.opportunityId)),
      ])
    ).map((item) => [item.id, item]),
  );
  const requestIds = experiments.flatMap((item) =>
    item.approvalRequestId === undefined ? [] : [item.approvalRequestId],
  );
  const requests = new Map(
    (await repositories.approvalRequests.getByIds(requestIds)).map((item) => [item.id, item]),
  );
  const totals = await funnel.totals(ids);
  const spent = await funnel.spent(ids);
  const views: ExperimentView[] = [];
  for (const [index, experiment] of experiments.entries()) {
    const hypothesis = hypotheses.get(experiment.hypothesisId);
    const opportunity = opportunities.get(experiment.opportunityId);
    if (hypothesis === undefined || opportunity === undefined) continue;
    views.push({
      number: index + 1,
      experiment,
      hypothesis,
      opportunity,
      totals: totals.get(experiment.id) ?? {},
      spent: spent.get(experiment.id) ?? ZERO_USD,
      request:
        experiment.approvalRequestId === undefined
          ? undefined
          : requests.get(experiment.approvalRequestId),
    });
  }
  return views;
}

/** The view of one experiment with its number among the active ones. */
async function viewOf(scope: Scope, experiment: Experiment): Promise<ExperimentView | undefined> {
  const active = await activeExperiments(scope.repositories);
  const index = active.findIndex((item) => item.id === experiment.id);
  const [view] = await viewsOf(scope, [experiment]);
  return view === undefined ? undefined : { ...view, number: index + 1 };
}

/** A launch request that can no longer be decided: the owner may request again. */
function requestLapsed(view: ExperimentView, at: Timestamp): boolean {
  const { request } = view;
  return request === undefined || request.status !== 'pending' || isApprovalExpired(request, at);
}

export function experimentCardText(view: ExperimentView, at: Timestamp): string {
  const { experiment, hypothesis, opportunity } = view;
  const metric = experiment.successMetric;
  const value = metricValue(metric, view.totals);
  const day = experimentDay(experiment, at);
  const number = view.number > 0 ? `№${String(view.number)} · ` : '';
  const lines = [
    `🧪 ${number}«${shorten(opportunity.title, 120)}» — ${METHOD_LABELS[hypothesis.validationMethod]} · ${hypothesis.geo}`,
    `Статус: ${STATUS_LABELS[experiment.status]}` +
      (day === undefined
        ? ''
        : ` · день ${String(Math.min(day.day, experiment.buildBudget.maxCalendarDays))} из ${String(experiment.buildBudget.maxCalendarDays)}`),
    `Оффер: ${shorten(hypothesis.offer, 120)} · ${formatUsd(hypothesis.price)} · канал: ${shorten(hypothesis.channel, 60)}`,
    `Успех: ${metricText(metric)} · сейчас ${valueText(metric, value)}` +
      (metricReached(metric, value) ? ' ✅' : ''),
    `Воронка: ${funnelLine(view.totals)}`,
    `Потрачено ${formatUsd(view.spent)} из ${formatUsd(experiment.testBudget)} · stop-loss ${formatUsd(experiment.stopLoss)}`,
  ];
  if (experiment.stopReason !== undefined) {
    lines.push(
      `Остановлен: ${STOP_LABELS[experiment.stopReason] ?? shorten(experiment.stopReason, 100)}`,
    );
  }
  if (experiment.status === 'running' && day?.overdue === true) {
    lines.push('⏰ Срок вышел — подведите итог.');
  }
  if (experiment.status === 'awaiting_approval' && requestLapsed(view, at)) {
    lines.push('⌛ Запрос на запуск больше не действует — запросите снова.');
  }
  if (experiment.status === 'running' || experiment.status === 'stopped') {
    lines.push(`Цифры: /funnel ${String(view.number)} клики 40 заявки 5 $12.50`);
  }
  return lines.join('\n');
}

function button(text: string, action: string, experiment: Experiment) {
  return callbackButton(
    text,
    `${EXPERIMENT_PREFIX}:${action}:${experiment.id}:${String(experiment.version)}`,
  );
}

export function experimentKeyboard(
  view: ExperimentView,
  at: Timestamp,
): InlineKeyboard | undefined {
  const { experiment } = view;
  const cancel = button('✖️ Отменить', 'x', experiment);
  switch (experiment.status) {
    case 'planned':
      return [
        [
          button(
            experiment.checksConfirmedAt === undefined
              ? '☑️ Чек-лист и запуск'
              : '🚀 Запросить запуск',
            'p',
            experiment,
          ),
          cancel,
        ],
      ];
    case 'awaiting_approval':
      return requestLapsed(view, at)
        ? [[button('🚀 Запросить снова', 'p', experiment), cancel]]
        : [[cancel]];
    case 'approved':
      return [[button('▶️ Тест запущен', 'g', experiment), cancel]];
    case 'running':
      return [[button('⏹ Остановить', 's', experiment), button('🏁 Итог', 'o', experiment)]];
    case 'stopped':
      return [[button('🏁 Итог', 'o', experiment)]];
    case 'completed':
    case 'cancelled':
      return undefined;
  }
}

export interface ExperimentFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
}

/** /experiments: one card per experiment not completed or cancelled. */
export async function sendExperiments(
  deps: ExperimentFlowDeps,
  reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>,
): Promise<void> {
  const active = await activeExperiments(deps.database.repositories);
  if (active.length === 0) {
    await reply(
      '🧪 Тестов пока нет.\n\nВыберите гипотезу в /hypotheses (кнопка 🧪 N): система составит ' +
        'план теста, затем — чек-лист честной проверки и запуск с вашего одобрения.',
    );
    return;
  }
  const views = await viewsOf(deps.database, active);
  const at = deps.now();
  const shown = views.slice(0, MAX_EXPERIMENT_CARDS);
  await reply(
    `🧪 Тесты: ${String(views.length)}` +
      (views.length > shown.length ? ` · показаны первые ${String(shown.length)}` : '') +
      '\nЦифры воронки и траты — /funnel; итоги — в /search «test result».',
  );
  for (const view of shown) {
    await reply(experimentCardText(view, at), experimentKeyboard(view, at));
  }
}

function checklistText(view: ExperimentView): string {
  const items = honestChecklist(view.hypothesis).map(
    (check, index) => `${String(index + 1)}. ${CHECK_LABELS[check]}`,
  );
  return [
    '☑️ Чек-лист честной проверки — подтвердите, что всё выполнено:',
    ...items,
    'Код проверил сам: метрика успеха и stop-loss зафиксированы до запуска; ценность описана ' +
      `результатом («${shorten(view.opportunity.valueProposition.measurableResult, 120)}»); ` +
      'траты — не больше одобренного бюджета.',
  ].join('\n');
}

function launchQuestion(view: ExperimentView): string {
  const total = formatUsd(experimentTotalBudget(view.experiment));
  const request = `Дальше — запрос на запуск в /decisions на ${total}.`;
  return view.experiment.checksConfirmedAt === undefined
    ? `${checklistText(view)}\n\n❓ ${request}`
    : `❓ Запросить запуск теста на ${total} в /decisions?`;
}

const QUESTIONS: Readonly<Record<Exclude<Step, 'launch'>, { text: string; button: string }>> = {
  cancel: { text: '✖️ Отменить тест? Гипотеза будет отброшена.', button: '✖️ Да, отменить' },
  go: {
    text:
      '▶️ Вы уже запустили тест (страница опубликована, сообщения отправлены)? Отсчёт срока ' +
      'начнётся сейчас.',
    button: '▶️ Да, запущен',
  },
  stop: {
    text: '⏹ Остановить тест? Цифры и траты можно вносить и после остановки, затем — 🏁 Итог.',
    button: '⏹ Да, остановить',
  },
};

function resultPreview(view: ExperimentView): string {
  const metric = view.experiment.successMetric;
  const value = metricValue(metric, view.totals);
  const reached = metricReached(metric, value);
  return (
    `🏁 Итог: ${metricText(metric)} — сейчас ${valueText(metric, value)}, ` +
    `${reached ? 'достигнута' : 'не достигнута'}. Гипотеза будет ` +
    `${VERDICT_LABELS[hypothesisVerdict(view.experiment, reached)]}. Выберите решение:`
  );
}

function outcomeKeyboard(experiment: Experiment): InlineKeyboard {
  const choice = (outcome: ExperimentOutcome) =>
    button(OUTCOMES[outcome].label, OUTCOMES[outcome].ask, experiment);
  return [
    [choice('scale'), choice('improve')],
    [choice('pivot'), choice('kill')],
    [button('Назад', 'c', experiment)],
  ];
}

type CommandOutcome =
  | { readonly outcome: 'done'; readonly text: string }
  | { readonly outcome: 'closed'; readonly text: string }
  | { readonly outcome: 'not_found' };

const STALE_TEXT = '⚠️ Карточка устарела: тест изменился. Откройте /experiments.';

function parseButton(data: string) {
  const [action, rawId, rawVersion] = data.split(':');
  const id = experimentIdSchema.safeParse(rawId);
  const version = Number(rawVersion);
  if (action === undefined || !id.success || !Number.isSafeInteger(version)) return undefined;
  return { action, id: id.data, version };
}

function outcomeOf(code: string, field: 'ask' | 'confirm'): ExperimentOutcome | undefined {
  return EXPERIMENT_OUTCOMES.find((outcome) => OUTCOMES[outcome][field] === code);
}

/** Button handler of experiment cards: ask → confirm → one owner command, or back. */
export async function handleExperimentButton(
  deps: ExperimentFlowDeps,
  context: CallbackContext,
): Promise<void> {
  const parsed = parseButton(context.data);
  if (parsed === undefined) {
    await context.answer('Кнопка устарела');
    return;
  }
  const { action, id, version } = parsed;
  const confirmStep = Object.hasOwn(CONFIRM_ACTIONS, action)
    ? CONFIRM_ACTIONS[action as keyof typeof CONFIRM_ACTIONS]
    : undefined;
  const confirmOutcome = outcomeOf(action, 'confirm');

  if (confirmStep === undefined && confirmOutcome === undefined) {
    // Showing a question, the outcomes or the card again changes nothing.
    const experiment = await deps.database.repositories.experiments.getById(id);
    const view = experiment === undefined ? undefined : await viewOf(deps.database, experiment);
    if (experiment === undefined || view === undefined) {
      await context.edit('Тест не найден.');
      return;
    }
    const at = deps.now();
    const card = experimentCardText(view, at);
    if (experiment.version !== version) {
      await context.edit(`${card}\n\n${STALE_TEXT}`, experimentKeyboard(view, at));
      return;
    }
    const step = Object.hasOwn(ASK_ACTIONS, action)
      ? ASK_ACTIONS[action as keyof typeof ASK_ACTIONS]
      : undefined;
    const askOutcome = outcomeOf(action, 'ask');
    if (step === 'launch') {
      await context.edit(`${card}\n\n${launchQuestion(view)}`, [
        [
          button(
            experiment.checksConfirmedAt === undefined
              ? '☑️ Да, всё выполнено'
              : '🚀 Да, запросить',
            'yp',
            experiment,
          ),
          button('Назад', 'c', experiment),
        ],
      ]);
    } else if (step !== undefined) {
      const question = QUESTIONS[step];
      await context.edit(`${card}\n\n❓ ${question.text}`, [
        [button(question.button, `y${action}`, experiment), button('Назад', 'c', experiment)],
      ]);
    } else if (action === 'o') {
      await context.edit(`${card}\n\n${resultPreview(view)}`, outcomeKeyboard(experiment));
    } else if (askOutcome !== undefined) {
      const choice = OUTCOMES[askOutcome];
      await context.edit(`${card}\n\n❓ ${choice.label}? ${choice.consequence}`, [
        [
          button('✅ Да, записать итог', choice.confirm, experiment),
          button('Назад', 'o', experiment),
        ],
      ]);
    } else {
      await context.edit(card, experimentKeyboard(view, at));
    }
    return;
  }

  const actor = deps.owner(context.userId);
  let result: CommandOutcome;
  try {
    ({ result } = await deps.database.command(
      {
        name: 'experiment.act',
        idempotencyKey: `tg-callback-${context.callbackQueryId}`,
        correlationId: `tg-update-${context.updateId}`,
      },
      async (scope): Promise<CommandOutcome> => {
        const experiment = await scope.repositories.experiments.getById(id);
        if (experiment === undefined) return { outcome: 'not_found' };
        if (experiment.version !== version) return { outcome: 'closed', text: STALE_TEXT };
        const view = await viewOf(scope, experiment);
        if (view === undefined) return { outcome: 'not_found' };
        const at = deps.now();
        if (confirmOutcome !== undefined) return finish(scope, view, confirmOutcome, actor, at);
        switch (confirmStep) {
          case 'launch':
            return requestLaunch(scope, view, actor, at);
          case 'cancel':
            return cancel(scope, view, actor, at);
          case 'go':
            return go(scope, view, actor, at);
          case 'stop':
            return stop(scope, view, actor, at);
          case undefined:
            return { outcome: 'closed', text: STALE_TEXT };
        }
      },
    ));
  } catch (error) {
    if (!(error instanceof ConcurrencyError)) throw error;
    context.logger.warn('experiment changed while the owner acted on it', { experiment_id: id });
    result = { outcome: 'closed', text: STALE_TEXT };
  }

  const experiment = await deps.database.repositories.experiments.getById(id);
  const view = experiment === undefined ? undefined : await viewOf(deps.database, experiment);
  if (result.outcome === 'not_found' || view === undefined) {
    await context.edit('Тест не найден.');
    return;
  }
  const at = deps.now();
  const card = experimentCardText(view, at);
  if (result.outcome === 'closed') {
    await context.edit(`${card}\n\n${result.text}`, experimentKeyboard(view, at));
    return;
  }
  context.logger.info('experiment changed by the owner', {
    experiment_id: id,
    status: view.experiment.status,
  });
  await context.edit(`${card}\n\n${result.text}`, experimentKeyboard(view, at));
  await context.answer('Записано');
}

const closed = (text: string): CommandOutcome => ({ outcome: 'closed', text });

async function requestLaunch(
  scope: TransactionScope,
  view: ExperimentView,
  actor: Actor,
  at: Timestamp,
): Promise<CommandOutcome> {
  const { repositories } = scope;
  let { experiment } = view;
  const context = { actor, at };
  if (experiment.status === 'awaiting_approval') {
    if (!requestLapsed(view, at))
      return closed('⏳ Запрос на запуск уже ждёт решения в /decisions.');
    if (view.request?.status === 'pending') {
      await repositories.approvalRequests.update(
        expireApprovalRequest(view.request, context),
        actor,
      );
    }
    experiment = returnExperimentToPlanning(experiment, context);
    await repositories.experiments.update(experiment, actor);
  } else if (experiment.status !== 'planned') {
    return closed(STALE_TEXT);
  }
  if (experiment.checksConfirmedAt === undefined) {
    experiment = confirmHonestChecks(experiment, view.hypothesis, context);
    await repositories.experiments.update(experiment, actor);
  }
  const total = experimentTotalBudget(experiment);
  const { hypothesis, opportunity } = view;
  const request = createApprovalRequest(
    {
      kind: 'experiment_launch',
      title: shorten(
        `Тест: «${shorten(opportunity.title, 100)}» — ${METHOD_LABELS[hypothesis.validationMethod]}`,
        200,
      ),
      summary: shorten(
        [
          `Гипотеза: ${shorten(hypothesis.statement, 400)}`,
          `Аудитория: ${shorten(hypothesis.audience, 120)} (${hypothesis.geo}) · цена ${formatUsd(hypothesis.price)} · канал: ${shorten(hypothesis.channel, 60)}`,
          `Успех: ${metricText(experiment.successMetric)} · бюджет ${formatUsd(experiment.testBudget)}, stop-loss ${formatUsd(experiment.stopLoss)} · срок ${String(experiment.buildBudget.maxCalendarDays)} дней`,
          `Чек-лист честной проверки подтверждён: ${String(experiment.honestChecks.length)} пунктов.`,
          'После ✅ запустите тест сами и нажмите ▶️ в /experiments.',
        ].join('\n'),
        3_000,
      ),
      subject: { type: 'experiment', id: experiment.id },
      amount: total,
      expiresAt: toTimestamp(new Date(timestampMs(at) + LAUNCH_REQUEST_DAYS * DAY_MS)),
    },
    { id: approvalRequestIdSchema.parse(uuidv7()), actor, at },
  );
  await repositories.approvalRequests.insert(request);
  await repositories.experiments.update(
    requestExperimentApproval(experiment, request.id, context),
    actor,
  );
  return {
    outcome: 'done',
    text: `🚀 Запуск на ${formatUsd(total)} запрошен — решение в /decisions (до ${formatTime(request.expiresAt)}).`,
  };
}

async function cancel(
  scope: TransactionScope,
  view: ExperimentView,
  actor: Actor,
  at: Timestamp,
): Promise<CommandOutcome> {
  const { repositories } = scope;
  const { experiment } = view;
  if (!['planned', 'awaiting_approval', 'approved'].includes(experiment.status)) {
    return closed(STALE_TEXT);
  }
  const context = { actor, at };
  if (view.request?.status === 'pending') {
    await repositories.approvalRequests.update(cancelApprovalRequest(view.request, context), actor);
  }
  await repositories.experiments.update(cancelExperiment(experiment, context), actor);
  if (view.hypothesis.status === 'selected') {
    await repositories.hypotheses.update(
      changeHypothesisStatus(view.hypothesis, 'discarded', context),
      actor,
    );
  }
  return { outcome: 'done', text: '✖️ Тест отменён, гипотеза отброшена.' };
}

async function go(
  scope: TransactionScope,
  view: ExperimentView,
  actor: Actor,
  at: Timestamp,
): Promise<CommandOutcome> {
  const { repositories } = scope;
  const { experiment, opportunity } = view;
  if (experiment.status !== 'approved') return closed(STALE_TEXT);
  if (!['approved', 'validating', 'scaling'].includes(opportunity.status)) {
    return closed('⛔ Возможность закрыта или на паузе — тест не запускается.');
  }
  const context = { actor, at };
  await repositories.experiments.update(startExperiment(experiment, context), actor);
  await repositories.hypotheses.update(
    changeHypothesisStatus(view.hypothesis, 'testing', context),
    actor,
  );
  if (opportunity.status === 'approved') {
    await repositories.opportunities.update(
      startOpportunityValidation(opportunity, context),
      actor,
    );
  }
  return {
    outcome: 'done',
    text: `▶️ Тест идёт. Вносите цифры и траты: /funnel ${String(view.number)} …`,
  };
}

async function stop(
  scope: TransactionScope,
  view: ExperimentView,
  actor: Actor,
  at: Timestamp,
): Promise<CommandOutcome> {
  if (view.experiment.status !== 'running') return closed(STALE_TEXT);
  await scope.repositories.experiments.update(
    stopExperiment(view.experiment, STOP_REASONS.owner, { actor, at }),
    actor,
  );
  return { outcome: 'done', text: '⏹ Тест остановлен. Когда цифры будут полными — 🏁 Итог.' };
}

/** The result in words of the Company Brain (English, like the other lessons). */
function resultSummary(
  view: ExperimentView,
  outcome: ExperimentOutcome,
  value: number | undefined,
  verdict: keyof typeof VERDICT_LABELS,
): string {
  const { experiment, hypothesis } = view;
  const metric = experiment.successMetric;
  const funnel = FUNNEL_STAGES.filter((stage) => (view.totals[stage] ?? 0) > 0)
    .map((stage) => `${stage} ${String(view.totals[stage])}`)
    .join(' → ');
  return shorten(
    [
      `Hypothesis: ${shorten(hypothesis.statement, 600)}`,
      `Method: ${hypothesis.validationMethod}; channel: ${shorten(hypothesis.channel, 100)}; ` +
        `price ${formatUsd(hypothesis.price)}; geo ${hypothesis.geo}.`,
      `Funnel: ${funnel === '' ? 'no events' : funnel}.`,
      `Success metric ${metric.name} at least ${String(metric.target)}${metric.unit === '%' ? '%' : ''}: ` +
        `${value === undefined ? 'no data' : String(value)} — ${metricReached(metric, value) ? 'reached' : 'not reached'}.`,
      `Spent ${formatUsd(view.spent)} of ${formatUsd(experiment.testBudget)} (stop-loss ${formatUsd(experiment.stopLoss)}).` +
        (experiment.stopReason === undefined ? '' : ` ${experiment.stopReason}.`),
      `Owner decision: ${outcome}. Hypothesis ${verdict}.`,
    ].join('\n'),
    3_000,
  );
}

async function finish(
  scope: TransactionScope,
  view: ExperimentView,
  outcome: ExperimentOutcome,
  actor: Actor,
  at: Timestamp,
): Promise<CommandOutcome> {
  const { repositories } = scope;
  const { experiment, hypothesis, opportunity } = view;
  if (experiment.status !== 'running' && experiment.status !== 'stopped') return closed(STALE_TEXT);
  if (outcome === 'kill') {
    const [row] = await scope.sql<{ count: string }[]>`
      select count(*)::text as count from experiments
      where opportunity_id = ${opportunity.id} and id <> ${experiment.id}
        and status in ('planned', 'awaiting_approval', 'approved', 'running', 'stopped')
    `;
    const others = Number(row?.count ?? 0);
    if (others > 0) {
      return closed(
        `⛔ Сначала завершите или отмените другие тесты этой возможности: ${String(others)} (/experiments).`,
      );
    }
  }
  const context = { actor, at };
  const metric = experiment.successMetric;
  const value = metricValue(metric, view.totals);
  const reached = metricReached(metric, value);
  const verdict = hypothesisVerdict(experiment, reached);
  const summary = resultSummary(view, outcome, value, verdict);
  const asset = createKnowledgeAsset(
    {
      kind: ASSET_KIND[outcome],
      title: shorten(
        `Test result — ${shorten(opportunity.title, 120)} (${hypothesis.validationMethod})`,
        200,
      ),
      summary,
      links: {
        evidenceIds: [],
        opportunityId: opportunity.id,
        hypothesisId: hypothesis.id,
        experimentId: experiment.id,
      },
      tags: ['experiment-result', hypothesis.validationMethod],
    },
    { id: knowledgeAssetIdSchema.parse(uuidv7()), actor, at },
  );
  await repositories.knowledgeAssets.insert(asset);
  const decision = createDecision(
    {
      subject: { type: 'experiment', id: experiment.id },
      outcome,
      rationale: summary,
      evidenceIds: [],
    },
    { id: decisionIdSchema.parse(uuidv7()), actor, at },
  );
  await repositories.decisions.insert(decision);
  await repositories.experiments.update(
    completeExperiment(experiment, { outcome, summary, assetIds: [asset.id] }, context),
    actor,
  );
  if (hypothesis.status === 'testing') {
    await repositories.hypotheses.update(
      changeHypothesisStatus(hypothesis, verdict, context),
      actor,
    );
  }
  const opportunityOutcome =
    (outcome === 'scale' && opportunity.status === 'validating') ||
    (outcome === 'kill' && opportunity.status !== 'killed')
      ? outcome
      : undefined;
  if (opportunityOutcome !== undefined) {
    const about = createDecision(
      {
        subject: { type: 'opportunity', id: opportunity.id },
        outcome: opportunityOutcome,
        rationale: shorten(
          `Owner decision after a test result: ${opportunityOutcome}.\n${summary}`,
          3_000,
        ),
        evidenceIds: [],
      },
      { id: decisionIdSchema.parse(uuidv7()), actor, at },
    );
    await repositories.decisions.insert(about);
    await repositories.opportunities.update(applyOpportunityDecision(opportunity, about), actor);
  }
  return {
    outcome: 'done',
    text:
      `${OUTCOMES[outcome].label}: итог записан. Гипотеза ${VERDICT_LABELS[verdict]}. ` +
      OUTCOMES[outcome].consequence,
  };
}

// ---------------------------------------------------------------- /funnel

export const FUNNEL_USAGE = [
  '📊 Внести цифры теста: /funnel <№> <шаг> <число> … [$<траты>]',
  'Например: /funnel 1 клики 40 заявки 5 $12.50',
  `Шаги: ${FUNNEL_STAGES.map((stage) => STAGE_LABELS[stage]).join(', ')} (или ключи: ${FUNNEL_STAGES.join(', ')}).`,
  'Числа — прирост с прошлого раза; № — из /experiments.',
].join('\n');

export interface FunnelReport {
  readonly number: number;
  readonly increments: Readonly<Partial<Record<FunnelStage, number>>>;
  readonly spendCents: number;
}

/** Parses `/funnel` arguments, or explains what is wrong (in Russian, for the owner). */
export function parseFunnelReport(args: string): FunnelReport | string {
  const tokens = args
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== '');
  if (tokens.length === 0) return FUNNEL_USAGE;
  const number = Number(tokens[0]?.replace(/^№/, ''));
  if (!Number.isSafeInteger(number) || number < 1)
    return `Сначала номер теста из /experiments.\n\n${FUNNEL_USAGE}`;
  const increments: Partial<Record<FunnelStage, number>> = {};
  let spendCents = 0;
  const money = (raw: string | undefined): number | undefined => {
    const value = Number(raw?.replace(/^\$/, '').replace(',', '.'));
    return Number.isFinite(value) && value > 0 && value <= MAX_REPORTED_SPEND_USD
      ? Math.round(value * 100)
      : undefined;
  };
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token.startsWith('$')) {
      const cents = money(token);
      if (cents === undefined)
        return `Траты — от $0.01 до $${String(MAX_REPORTED_SPEND_USD)}: ${token}`;
      spendCents += cents;
      continue;
    }
    if (SPEND_WORDS.has(token)) {
      const cents = money(tokens[index + 1]);
      if (cents === undefined) return `После «${token}» — сумма в долларах, например 12.50.`;
      spendCents += cents;
      index += 1;
      continue;
    }
    const stage = STAGE_WORDS[token];
    if (stage === undefined) return `Не знаю шаг «${shorten(token, 30)}».\n\n${FUNNEL_USAGE}`;
    const count = Number(tokens[index + 1]);
    if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) {
      return `После «${token}» — целое число от 1 до 1 000 000.`;
    }
    increments[stage] = (increments[stage] ?? 0) + count;
    index += 1;
  }
  if (Object.keys(increments).length === 0 && spendCents === 0) {
    return `Нет ни цифр, ни трат.\n\n${FUNNEL_USAGE}`;
  }
  if (spendCents > MAX_REPORTED_SPEND_USD * 100) {
    return `За один раз — не больше $${String(MAX_REPORTED_SPEND_USD)} трат.`;
  }
  return { number, increments, spendCents };
}

interface PendingReport {
  readonly experimentId: Experiment['id'];
  readonly report: FunnelReport;
  readonly expiresAtMs: number;
}

export interface FunnelFlow {
  readonly funnel: (context: CommandContext) => Promise<void>;
  readonly handleButton: (context: CallbackContext) => Promise<void>;
}

type FunnelOutcome =
  | { readonly outcome: 'recorded'; readonly stopped?: string | undefined }
  | { readonly outcome: 'closed'; readonly text: string };

/**
 * /funnel records funnel numbers and spend, so it asks for confirmation first (was → will be,
 * the stop-loss); the report waits in memory for 10 minutes. The write is one idempotent owner
 * command: events, the cost entry within the approved budget, and the automatic stop.
 */
export function createFunnelFlow(deps: ExperimentFlowDeps): FunnelFlow {
  const pending = new Map<string, PendingReport>();
  const nowMs = (): number => timestampMs(deps.now());

  function remember(entry: Omit<PendingReport, 'expiresAtMs'>): string {
    const current = nowMs();
    for (const [nonce, item] of pending) {
      if (item.expiresAtMs <= current) pending.delete(nonce);
    }
    while (pending.size >= MAX_PENDING) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
    const nonce = randomBytes(8).toString('hex');
    pending.set(nonce, { ...entry, expiresAtMs: current + CONFIRMATION_TTL_MS });
    return nonce;
  }

  return {
    async funnel(context) {
      const report = parseFunnelReport(context.args);
      if (typeof report === 'string') {
        await context.reply(report);
        return;
      }
      const active = await activeExperiments(deps.database.repositories);
      const experiment = active[report.number - 1];
      if (experiment === undefined) {
        await context.reply(`Теста №${String(report.number)} нет. Номера — в /experiments.`);
        return;
      }
      if (experiment.status !== 'running' && experiment.status !== 'stopped') {
        await context.reply(
          `Тест №${String(report.number)} ещё не запущен: ${STATUS_LABELS[experiment.status]}.`,
        );
        return;
      }
      const [view] = await viewsOf(deps.database, [experiment]);
      if (view === undefined) {
        await context.reply('Тест не найден.');
        return;
      }
      const spendAfter = addMoney(view.spent, usd(report.spendCents));
      if (compareMoney(spendAfter, experimentTotalBudget(experiment)) > 0) {
        await context.reply(
          `⛔ Траты превысят одобренный бюджет ${formatUsd(experimentTotalBudget(experiment))}: ` +
            `уже ${formatUsd(view.spent)}. Ничего не записано.`,
        );
        return;
      }
      const after: Partial<Record<FunnelStage, number>> = { ...view.totals };
      const lines = [
        `📊 Тест №${String(report.number)} · «${shorten(view.opportunity.title, 100)}» — ${METHOD_LABELS[view.hypothesis.validationMethod]}`,
      ];
      for (const stage of FUNNEL_STAGES) {
        const added = report.increments[stage];
        if (added === undefined) continue;
        const before = view.totals[stage] ?? 0;
        after[stage] = before + added;
        lines.push(
          `${STAGE_LABELS[stage]}: ${String(before)} → ${String(before + added)} (+${String(added)})`,
        );
      }
      const metric = experiment.successMetric;
      const value = metricValue(metric, after);
      const reached = metricReached(metric, value);
      if (report.spendCents > 0) {
        lines.push(
          `Потрачено: ${formatUsd(view.spent)} → ${formatUsd(spendAfter)} из ${formatUsd(experiment.testBudget)} · stop-loss ${formatUsd(experiment.stopLoss)}`,
        );
      }
      lines.push(`Успех: ${metricText(metric)} · станет ${valueText(metric, value)}`);
      const stopReason = automaticStopReason(experiment, spendAfter, reached);
      if (stopReason !== undefined) {
        lines.push(`⚠️ Тест остановится: ${STOP_LABELS[stopReason] ?? stopReason}.`);
      }
      lines.push('', 'Записать? Подтверждение действует 10 минут.');
      const nonce = remember({ experimentId: experiment.id, report });
      await context.reply(lines.join('\n'), [
        [
          callbackButton('📊 Записать', `${FUNNEL_PREFIX}:y:${nonce}`),
          callbackButton('Отмена', `${FUNNEL_PREFIX}:n:${nonce}`),
        ],
      ]);
    },

    async handleButton(context) {
      const [answer, nonce] = context.data.split(':');
      const confirmation = nonce === undefined ? undefined : pending.get(nonce);
      if (answer === 'n' && nonce !== undefined) {
        pending.delete(nonce);
        await context.edit('Отменено. Ничего не записано.');
        return;
      }
      if (answer !== 'y' || confirmation === undefined || confirmation.expiresAtMs <= nowMs()) {
        await context.edit('⌛ Подтверждение устарело. Повторите /funnel.');
        return;
      }
      const actor = deps.owner(context.userId);
      const correlationId = `tg-update-${String(context.updateId)}`;
      let result: FunnelOutcome;
      try {
        ({ result } = await deps.database.command(
          {
            name: 'experiment.funnel',
            idempotencyKey: `tg-callback-${context.callbackQueryId}`,
            correlationId,
          },
          (scope) => recordReport(scope, confirmation, actor, deps.now(), correlationId),
        ));
      } catch (error) {
        if (error instanceof FunnelRefusedError) {
          result = {
            outcome: 'closed',
            text: '⛔ Траты превышают одобренный бюджет теста — ничего не записано.',
          };
        } else if (error instanceof ConcurrencyError) {
          result = {
            outcome: 'closed',
            text: '⚠️ Тест изменился одновременно с записью. Повторите /funnel.',
          };
        } else {
          throw error;
        }
      }
      if (nonce !== undefined) pending.delete(nonce);
      if (result.outcome === 'closed') {
        await context.edit(result.text);
        return;
      }
      context.logger.info('experiment funnel reported by the owner', {
        experiment_id: confirmation.experimentId,
        stopped: result.stopped !== undefined,
      });
      await context.edit(
        '📊 Записано. Карточка теста — /experiments.' +
          (result.stopped === undefined
            ? ''
            : `\n⏹ Тест остановлен: ${STOP_LABELS[result.stopped] ?? result.stopped}. Подведите итог (🏁) в /experiments.`),
      );
      await context.answer('Записано');
    },
  };
}

async function recordReport(
  scope: TransactionScope,
  confirmation: PendingReport,
  actor: Actor,
  at: Timestamp,
  correlationId: string,
): Promise<FunnelOutcome> {
  const { repositories, funnel } = scope;
  const experiment = await repositories.experiments.getById(confirmation.experimentId);
  if (
    experiment === undefined ||
    (experiment.status !== 'running' && experiment.status !== 'stopped')
  ) {
    return {
      outcome: 'closed',
      text: 'Тест уже не идёт — ничего не записано. Откройте /experiments.',
    };
  }
  const hypothesis = await repositories.hypotheses.getById(experiment.hypothesisId);
  if (hypothesis === undefined) return { outcome: 'closed', text: 'Тест не найден.' };
  const { report } = confirmation;
  await funnel.record(
    FUNNEL_STAGES.flatMap((stage) => {
      const quantity = report.increments[stage];
      return quantity === undefined
        ? []
        : [
            {
              experimentId: experiment.id,
              hypothesisId: hypothesis.id,
              stage,
              quantity,
              channel: hypothesis.channel,
              utm: {},
              occurredAt: at,
              source: 'owner_report' as const,
            },
          ];
    }),
    actor,
    correlationId,
  );
  const spentBefore = (await funnel.spent([experiment.id])).get(experiment.id) ?? ZERO_USD;
  let spent = spentBefore;
  if (report.spendCents > 0) {
    const approval =
      experiment.approvalRequestId === undefined
        ? undefined
        : await repositories.approvalRequests.getById(experiment.approvalRequestId);
    try {
      const entry = recordExperimentCost(
        {
          amount: usd(report.spendCents),
          description: shorten(`Test spend reported by the owner (${hypothesis.channel})`, 500),
          incurredAt: at,
        },
        experiment,
        approval,
        spentBefore,
        { id: costEntryIdSchema.parse(uuidv7()), actor, at },
      );
      await repositories.costEntries.insert(entry);
      spent = addMoney(spentBefore, entry.amount);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'approval_required') {
        // Thrown inside the command: nothing of this report is stored.
        throw new FunnelRefusedError();
      }
      throw error;
    }
  }
  const totals = (await funnel.totals([experiment.id])).get(experiment.id) ?? {};
  const reached = metricReached(
    experiment.successMetric,
    metricValue(experiment.successMetric, totals),
  );
  const stopReason = automaticStopReason(experiment, spent, reached);
  if (stopReason !== undefined) {
    await repositories.experiments.update(
      stopExperiment(experiment, stopReason, { actor, at }),
      actor,
    );
  }
  return { outcome: 'recorded', stopped: stopReason };
}

/** Spend above the approved budget: the whole report is rolled back. */
export class FunnelRefusedError extends Error {
  override readonly name = 'FunnelRefusedError';
  constructor() {
    super('The reported spend is above the approved experiment budget');
  }
}

// ---------------------------------------------------------------- Launch decisions

/**
 * The owner's decision on an `experiment_launch` request (/decisions): ✅ approves the launch
 * (the domain checks the kind, the amount and the subject), ❌ returns the test to planning.
 */
export async function applyExperimentLaunchDecision(
  repositories: Repositories,
  request: ApprovalRequest,
  actor: Actor,
  at: Timestamp,
): Promise<'launch_approved' | 'launch_rejected' | undefined> {
  if (request.kind !== 'experiment_launch' || request.subject?.type !== 'experiment') {
    return undefined;
  }
  const experiment = await repositories.experiments.getById(
    experimentIdSchema.parse(request.subject.id),
  );
  if (experiment?.status !== 'awaiting_approval' || experiment.approvalRequestId !== request.id) {
    return undefined;
  }
  const context = { actor, at };
  if (request.status === 'approved') {
    await repositories.experiments.update(approveExperiment(experiment, request, context), actor);
    return 'launch_approved';
  }
  await repositories.experiments.update(returnExperimentToPlanning(experiment, context), actor);
  return 'launch_rejected';
}
