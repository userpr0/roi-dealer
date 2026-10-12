import { toTimestamp, type Actor, type Timestamp } from '@roi-dealer/domain';
import type { Database } from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';
import type {
  BotCommandDefinition,
  CallbackContext,
  CallbackHandlerDefinition,
  CommandContext,
} from '@roi-dealer/telegram';
import type { Permission } from '@roi-dealer/policies';
import {
  ACCESS_PREFIX,
  createAccessAudit,
  handleAccessButton,
  sendAccessOverview,
  type RefusedAttempt,
} from './access.js';
import { APPROVAL_PREFIX, handleApprovalButton, sendDecisionCards } from './approvals.js';
import { buildDigest, createDigestScheduler, sendDailyDigest } from './digest.js';
import {
  callbackPrefix,
  choosePeriodText,
  isPeriod,
  journalText,
  periodKeyboard,
  type JournalKind,
} from './journal.js';
import { createKillSwitchFlow, KILL_SWITCH_PREFIX, killSwitchStatus } from './kill-switch.js';
import { NO_DATABASE_TEXT } from './texts.js';

export interface CommandCenterOptions {
  /** Without a database the panel commands explain that it is not connected. */
  readonly database?: Database | undefined;
  readonly logger: Logger;
  /** Delivers the scheduled digest to the owner; must throw when delivery fails. */
  readonly deliverDigest: (text: string) => Promise<void>;
  readonly now?: () => number;
}

export interface CommandCenter {
  /** /decisions, /stop, /resume, /journal, /history, /digest, /access */
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
    callbacks: [APPROVAL_PREFIX, KILL_SWITCH_PREFIX, ACCESS_PREFIX, 'jr', 'hs'].map((prefix) => ({
      prefix,
      handler: answer,
    })),
    statusLines: () => Promise.resolve(['⚪ База данных не подключена: пульт недоступен']),
    refused: () => Promise.resolve(),
  };
}

/**
 * The owner command center (13b, PHASE 04): approvals, kill switch, journal, history, digest
 * and access. Every command and button is checked against the owner's permissions and
 * recorded in the access log.
 */
export function createCommandCenter(options: CommandCenterOptions): CommandCenter {
  const { database, logger } = options;
  const nowMs = options.now ?? Date.now;
  if (database === undefined) {
    return {
      ...withoutDatabase(),
      startDigest: () => undefined,
      stopDigest: () => Promise.resolve(),
    };
  }

  const now = (): Timestamp => toTimestamp(new Date(nowMs()));
  const deps = { database, now, owner: ownerActor };
  const killSwitch = createKillSwitchFlow(deps);
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
      const outcome = await sendDailyDigest(database, date, nowMs(), options.deliverDigest);
      logger.info('daily digest', { date, outcome, correlation_id: `digest-${date}` });
    },
  });

  return {
    commands: [
      command('decisions', 'decisions.read', (context) =>
        sendDecisionCards(deps, (text, keyboard) => context.reply(text, keyboard)),
      ),
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
    ],
    callbacks: [
      button(APPROVAL_PREFIX, 'approval.update', (context) => handleApprovalButton(deps, context)),
      button(KILL_SWITCH_PREFIX, 'system.control', killSwitch.handleButton),
      button(ACCESS_PREFIX, 'access.manage', (context) => handleAccessButton(deps, context)),
      journalButton('journal'),
      journalButton('history'),
    ],
    async statusLines(request) {
      if (request !== undefined) await audit.allow(request.userId, request.updateId, 'status.read');
      return [await killSwitchStatus(database.repositories, database.events)];
    },
    refused: (attempt) => audit.refused(attempt),
    startDigest: () => scheduler.start(),
    stopDigest: () => scheduler.stop(),
  };
}
