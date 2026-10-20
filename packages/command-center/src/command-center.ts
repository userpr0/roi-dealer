import { toTimestamp, type Actor, type Timestamp } from '@roi-dealer/domain';
import type { Database } from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';
import type {
  BotCommandDefinition,
  CallbackContext,
  CallbackHandlerDefinition,
  CommandContext,
  InlineKeyboard,
} from '@roi-dealer/telegram';
import type { Permission } from '@roi-dealer/policies';
import {
  ACCESS_PREFIX,
  createAccessAudit,
  handleAccessButton,
  sendAccessOverview,
  type RefusedAttempt,
} from './access.js';
import {
  APPROVAL_PREFIX,
  decidableRequests,
  handleApprovalButton,
  sendDecisionCards,
} from './approvals.js';
import { buildDigest, createDigestScheduler, sendDailyDigest } from './digest.js';
import {
  callbackPrefix,
  choosePeriodText,
  isPeriod,
  journalText,
  periodKeyboard,
  type JournalKind,
} from './journal.js';
import { agentsText } from './agents.js';
import {
  createFunnelFlow,
  EXPERIMENT_PREFIX,
  FUNNEL_PREFIX,
  handleExperimentButton,
  sendExperiments,
} from './experiments.js';
import { handleHypothesisButton, HYPOTHESIS_PREFIX, sendHypotheses } from './hypotheses.js';
import { COST_PREFIX, createCostFlow, economicsReply } from './economics.js';
import { aiStatusLine } from './ai-status.js';
import { askReply, createNoteFlow, NOTE_PREFIX, searchReply } from './brain.js';
import { opportunitiesText } from './opportunities.js';
import {
  createDecisionCardNotifier,
  handleOpportunityButton,
  MAX_OPPORTUNITY_CARDS,
  OPPORTUNITY_PREFIX,
  reviewQueue,
  sendOpportunityCards,
} from './opportunity-cards.js';
import { handlePainButton, PAIN_PREFIX, painsReply } from './pains.js';
import { handlePortfolioButton, PORTFOLIO_PREFIX, sendPortfolio } from './portfolio.js';
import {
  createForgetFlow,
  FORGET_PREFIX,
  handleLeadButton,
  LEADS_PREFIX,
  sendLeads,
} from './leads.js';
import { handleMediaButton, MEDIA_PREFIX } from './media.js';
import { CHECKOUT_PREFIX, createCheckoutFlow } from './payments.js';
import { CONTRIBUTION_PREFIX, createRewardFlow, REWARD_PREFIX } from './rewards.js';
import { isReviewDay, sendWeeklyReview, statsText, weeklyReviewText } from './stats.js';
import { createKillSwitchFlow, KILL_SWITCH_PREFIX, killSwitchStatus } from './kill-switch.js';
import { NO_DATABASE_TEXT } from './texts.js';
import { createServiceWatchdog, setupStatus } from './watchdog.js';

export interface CommandCenterOptions {
  /** Without a database the panel commands explain that it is not connected. */
  readonly database?: Database | undefined;
  readonly logger: Logger;
  /** Delivers the scheduled digest to the owner; must throw when delivery fails. */
  readonly deliverDigest: (text: string) => Promise<void>;
  /** Delivers a decision card with its buttons to the owner (PHASE 12); must throw on failure. */
  readonly deliverCard?: ((text: string, keyboard?: InlineKeyboard) => Promise<void>) | undefined;
  /** How often new decision cards are looked for; default 5 minutes. */
  readonly cardIntervalMs?: number | undefined;
  /** The api's public address (`PUBLIC_API_URL`): preview links of landings (PHASE 19a). */
  readonly publicApiUrl?: string | undefined;
  /**
   * The bot's version and start (13c): the watchdog compares the services' versions with it.
   * Without them the watchdog does not run.
   */
  readonly watchdog?:
    | {
        readonly version: string;
        readonly startedAtMs: number;
        /** Default: one minute. */
        readonly intervalMs?: number | undefined;
      }
    | undefined;
  readonly now?: () => number;
}

export interface CommandCenter {
  /**
   * /decisions, /stop, /resume, /journal, /history, /digest, /access, /pains, /opportunities,
   * /search, /ask, /note, /hypotheses, /experiments, /funnel, /economics, /cost, /portfolio,
   * /stats, /review, /agents
   */
  readonly commands: readonly BotCommandDefinition[];
  readonly callbacks: readonly CallbackHandlerDefinition[];
  /**
   * Lines for /status: the kill switch, or that the database is not connected.
   * With the request, the view is recorded in the access log.
   */
  statusLines(request?: { readonly userId: number; readonly updateId: number }): Promise<string[]>;
  /** Records a message or button press the router refused (PHASE 04). */
  refused(attempt: RefusedAttempt): Promise<void>;
  /** Starts the daily digest at 10:00 Kyiv (no-op without a database). */
  startDigest(): void;
  stopDigest(): Promise<void>;
  /** Sends the cards of opportunities under review as they arrive (no-op without a database). */
  startCards(): void;
  stopCards(): Promise<void>;
  /** Watches the worker and the api and tells the owner about incidents (13c). */
  startWatchdog(): void;
  stopWatchdog(): Promise<void>;
}

/**
 * The owner acts from Telegram as `owner`; the actor id records the channel and the account
 * (audit, §2.11). The router has already checked that the sender is the owner.
 */
export function ownerActor(telegramUserId: number): Actor {
  return { type: 'owner', id: `telegram:${telegramUserId}` };
}

const DESCRIPTIONS = {
  decisions: 'Решения, которые ждут вас',
  stop: 'Стоп-кран: остановить автоматизации',
  resume: 'Возобновить автоматизации',
  journal: 'Журнал изменений: день, неделя, месяц',
  history: 'История решений и денег',
  digest: 'Дайджест сейчас',
  access: 'Доступы агентов и интеграций',
  pains: 'Боли, которые нашла система',
  opportunities: 'Возможности с оценкой',
  search: 'Поиск по базе',
  ask: 'Спросить систему',
  note: 'Записать знание',
  hypotheses: 'Гипотезы проверки одобренных возможностей',
  experiments: 'Тесты: чек-лист, запуск, итог',
  funnel: 'Внести цифры теста: воронка, траты, выручка',
  economics: 'Экономика месяца: расходы, лимиты, выручка, ROI',
  cost: 'Записать расход вне тестов',
  portfolio: 'Возможности в работе: пауза, продолжить, закрыть',
  stats: 'Статистика цикла и метрики системы',
  review: 'Недельный разбор сейчас',
  agents: 'Агенты: доступ, работа, AI за сутки',
  rewards: 'Вклады и вознаграждения',
  contribution: 'Записать вклад участника',
  reward: 'Начислить вознаграждение за вклады',
  paid: 'Отметить выплату вознаграждения',
  leads: 'Заявки со страниц тестов: связаться, клиент, итог',
  forget: 'Удалить почту человека по его просьбе',
  checkout: 'Ссылка на оплату предзаказа (Lemon Squeezy)',
} as const;

const NO_PERMISSION_TEXT = '⛔ Нет прав на это действие.';

function withoutDatabase(): Pick<
  CommandCenter,
  'commands' | 'callbacks' | 'statusLines' | 'refused'
> {
  const reply = (context: CommandContext): Promise<void> => context.reply(NO_DATABASE_TEXT);
  const answer = (context: CallbackContext): Promise<void> => context.edit(NO_DATABASE_TEXT);
  return {
    commands: Object.entries(DESCRIPTIONS).map(([name, description]) => ({
      name,
      description,
      handler: reply,
    })),
    callbacks: [
      APPROVAL_PREFIX,
      OPPORTUNITY_PREFIX,
      HYPOTHESIS_PREFIX,
      EXPERIMENT_PREFIX,
      FUNNEL_PREFIX,
      COST_PREFIX,
      PORTFOLIO_PREFIX,
      PAIN_PREFIX,
      MEDIA_PREFIX,
      LEADS_PREFIX,
      FORGET_PREFIX,
      CHECKOUT_PREFIX,
      CONTRIBUTION_PREFIX,
      REWARD_PREFIX,
      KILL_SWITCH_PREFIX,
      ACCESS_PREFIX,
      NOTE_PREFIX,
      'jr',
      'hs',
    ].map((prefix) => ({
      prefix,
      handler: answer,
    })),
    statusLines: () => Promise.resolve(['⚪ База данных не подключена: пульт недоступен']),
    refused: () => Promise.resolve(),
  };
}

/**
 * The owner command center (13b, PHASE 04, 06–08): approvals, kill switch, journal, history,
 * digest, access, the pains and opportunities the system found, and the Company Brain: search,
 * questions answered from the database and the owner's notes. Every command and button is
 * checked against the owner's permissions and recorded in the access log.
 */
export function createCommandCenter(options: CommandCenterOptions): CommandCenter {
  const { database, logger } = options;
  const nowMs = options.now ?? Date.now;
  if (database === undefined) {
    return {
      ...withoutDatabase(),
      startDigest: () => undefined,
      stopDigest: () => Promise.resolve(),
      startCards: () => undefined,
      stopCards: () => Promise.resolve(),
      startWatchdog: () => undefined,
      stopWatchdog: () => Promise.resolve(),
    };
  }

  const now = (): Timestamp => toTimestamp(new Date(nowMs()));
  const deps = { database, now, owner: ownerActor };
  const killSwitch = createKillSwitchFlow(deps);
  const notes = createNoteFlow(deps);
  const funnel = createFunnelFlow(deps);
  const costs = createCostFlow(deps);
  const rewards = createRewardFlow(deps);
  const forget = createForgetFlow(deps);
  const checkouts = createCheckoutFlow(deps);
  const audit = createAccessAudit({ database, logger, now, owner: ownerActor });

  /** Checks the permission and records the use before running the handler. */
  function command(
    name: keyof typeof DESCRIPTIONS,
    permission: Permission,
    handler: (context: CommandContext) => Promise<void>,
  ): BotCommandDefinition {
    return {
      name,
      description: DESCRIPTIONS[name],
      handler: async (context) => {
        if (await audit.allow(context.userId, context.updateId, permission)) {
          await handler(context);
        } else {
          await context.reply(NO_PERMISSION_TEXT);
        }
      },
    };
  }
  function button(
    prefix: string,
    permission: Permission,
    handler: (context: CallbackContext) => Promise<void>,
  ): CallbackHandlerDefinition {
    return {
      prefix,
      handler: async (context) => {
        if (await audit.allow(context.userId, context.updateId, permission)) {
          await handler(context);
        } else {
          await context.answer(NO_PERMISSION_TEXT);
        }
      },
    };
  }

  const JOURNAL_PERMISSIONS = { journal: 'journal.read', history: 'history.read' } as const;
  const journal = (kind: JournalKind): BotCommandDefinition =>
    command(kind, JOURNAL_PERMISSIONS[kind], (context) =>
      context.reply(choosePeriodText(kind), periodKeyboard(kind)),
    );
  const journalButton = (kind: JournalKind): CallbackHandlerDefinition =>
    button(callbackPrefix(kind), JOURNAL_PERMISSIONS[kind], async (context) => {
      if (!isPeriod(context.data)) {
        await context.answer('Кнопка устарела');
        return;
      }
      const text = await journalText(database.events, kind, context.data, nowMs());
      await context.edit(text, periodKeyboard(kind, context.data));
    });

  const scheduler = createDigestScheduler({
    logger,
    now: nowMs,
    send: async (date) => {
      // D-014 п.12: on Monday the weekly review replaces the daily digest.
      const outcome = isReviewDay(date)
        ? await sendWeeklyReview(
            database,
            date,
            nowMs(),
            options.deliverDigest,
            options.deliverCard,
          )
        : await sendDailyDigest(database, date, nowMs(), options.deliverDigest);
      logger.info('daily digest', { date, outcome, correlation_id: `digest-${date}` });
    },
  });

  const deliverCard = options.deliverCard;
  const cards =
    deliverCard === undefined
      ? undefined
      : createDecisionCardNotifier({
          database,
          logger,
          deliver: deliverCard,
          now: nowMs,
          intervalMs: options.cardIntervalMs,
          publicApiUrl: options.publicApiUrl,
        });
  const setup = { publicApiUrl: options.publicApiUrl !== undefined };
  const watchdog =
    options.watchdog === undefined
      ? undefined
      : createServiceWatchdog({
          database,
          logger,
          deliver: options.deliverDigest,
          version: options.watchdog.version,
          startedAtMs: options.watchdog.startedAtMs,
          intervalMs: options.watchdog.intervalMs,
          now: nowMs,
          setup,
        });

  return {
    commands: [
      command('decisions', 'decisions.read', async (context) => {
        const reply = (text: string, keyboard?: InlineKeyboard) => context.reply(text, keyboard);
        const queue = await reviewQueue(database.repositories);
        if (queue.length === 0) {
          await sendDecisionCards(deps, reply);
          return;
        }
        if ((await decidableRequests(database.repositories, now())).length > 0) {
          await sendDecisionCards(deps, reply);
        }
        await reply(
          `⚖️ Возможностей на решение: ${String(queue.length)}` +
            (queue.length > MAX_OPPORTUNITY_CARDS
              ? ` · показаны ${String(MAX_OPPORTUNITY_CARDS)}, старые — первыми`
              : ''),
        );
        await sendOpportunityCards(deps, queue, reply);
      }),
      command('stop', 'system.control', killSwitch.stop),
      command('resume', 'system.control', killSwitch.resume),
      journal('journal'),
      journal('history'),
      command('digest', 'digest.read', async (context) =>
        context.reply(await buildDigest(database, nowMs())),
      ),
      command('access', 'access.read', (context) =>
        sendAccessOverview(deps, (text, keyboard) => context.reply(text, keyboard)),
      ),
      command('pains', 'research.read', async (context) => {
        const reply = await painsReply(database.repositories);
        await context.reply(reply.text, reply.keyboard);
      }),
      command('opportunities', 'research.read', async (context) =>
        context.reply(
          await opportunitiesText(
            database.repositories,
            database.opportunityAssessments,
            database.judgements,
          ),
        ),
      ),
      command('search', 'research.read', async (context) =>
        context.reply(await searchReply(database, context.args)),
      ),
      command('ask', 'research.read', async (context) =>
        context.reply(await askReply(database, context.args, nowMs())),
      ),
      command('note', 'research.write', notes.note),
      command('hypotheses', 'research.read', (context) =>
        sendHypotheses(database.repositories, (text, keyboard) => context.reply(text, keyboard)),
      ),
      command('experiments', 'research.read', (context) =>
        sendExperiments(deps, (text, keyboard) => context.reply(text, keyboard)),
      ),
      command('funnel', 'experiment.write', funnel.funnel),
      command('economics', 'history.read', async (context) =>
        context.reply(await economicsReply(database, nowMs())),
      ),
      command('cost', 'cost.record', costs.cost),
      command('portfolio', 'research.read', (context) =>
        sendPortfolio(deps, (text, keyboard) => context.reply(text, keyboard)),
      ),
      command('stats', 'history.read', async (context) =>
        context.reply(await statsText(database, nowMs())),
      ),
      command('review', 'history.read', async (context) =>
        context.reply(await weeklyReviewText(database, nowMs())),
      ),
      command('agents', 'status.read', async (context) =>
        context.reply(await agentsText(database, nowMs())),
      ),
      command('rewards', 'history.read', rewards.rewards),
      command('contribution', 'contribution.write', rewards.contribution),
      command('reward', 'reward.write', rewards.reward),
      command('paid', 'reward.write', rewards.paid),
      command('leads', 'lead.manage', (context) => sendLeads(deps, context)),
      command('forget', 'lead.manage', forget.forget),
      command('checkout', 'experiment.write', checkouts.checkout),
    ],
    callbacks: [
      button(APPROVAL_PREFIX, 'approval.update', (context) => handleApprovalButton(deps, context)),
      button(OPPORTUNITY_PREFIX, 'decision.record', (context) =>
        handleOpportunityButton(deps, context),
      ),
      button(HYPOTHESIS_PREFIX, 'experiment.write', (context) =>
        handleHypothesisButton(deps, context),
      ),
      button(EXPERIMENT_PREFIX, 'experiment.write', (context) =>
        handleExperimentButton(deps, context),
      ),
      button(FUNNEL_PREFIX, 'experiment.write', funnel.handleButton),
      button(COST_PREFIX, 'cost.record', costs.handleButton),
      button(PORTFOLIO_PREFIX, 'decision.record', (context) =>
        handlePortfolioButton(deps, context),
      ),
      button(PAIN_PREFIX, 'research.write', (context) => handlePainButton(deps, context)),
      button(MEDIA_PREFIX, 'research.write', (context) =>
        handleMediaButton({ ...deps, publicApiUrl: options.publicApiUrl }, context),
      ),
      button(LEADS_PREFIX, 'lead.manage', (context) => handleLeadButton(deps, context)),
      button(FORGET_PREFIX, 'lead.manage', forget.handleButton),
      button(CHECKOUT_PREFIX, 'experiment.write', checkouts.handleButton),
      button(CONTRIBUTION_PREFIX, 'contribution.write', rewards.handleContributionButton),
      button(REWARD_PREFIX, 'reward.write', rewards.handleRewardButton),
      button(KILL_SWITCH_PREFIX, 'system.control', killSwitch.handleButton),
      button(ACCESS_PREFIX, 'access.manage', (context) => handleAccessButton(deps, context)),
      button(NOTE_PREFIX, 'research.write', notes.handleButton),
      journalButton('journal'),
      journalButton('history'),
    ],
    async statusLines(request) {
      if (request !== undefined) await audit.allow(request.userId, request.updateId, 'status.read');
      return [
        await killSwitchStatus(database.repositories, database.events),
        await aiStatusLine(database.aiCalls, nowMs()),
        ...(await setupStatus(database, setup, nowMs())).lines,
      ];
    },
    refused: (attempt) => audit.refused(attempt),
    startDigest: () => scheduler.start(),
    stopDigest: () => scheduler.stop(),
    startCards: () => cards?.start(),
    stopCards: () => cards?.stop() ?? Promise.resolve(),
    startWatchdog: () => watchdog?.start(),
    stopWatchdog: () => watchdog?.stop() ?? Promise.resolve(),
  };
}
