import { toTimestamp, type Actor, type Timestamp } from '@roi-dealer/domain';
import type { Database } from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';
import type {
  BotCommandDefinition,
  CallbackContext,
  CallbackHandlerDefinition,
  CommandContext,
} from '@roi-dealer/telegram';
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
  /** /decisions, /stop, /resume, /journal, /history, /digest */
  readonly commands: readonly BotCommandDefinition[];
  readonly callbacks: readonly CallbackHandlerDefinition[];
  /** Lines for /status: the kill switch, or that the database is not connected. */
  statusLines(): Promise<string[]>;
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
} as const;

function withoutDatabase(): Pick<CommandCenter, 'commands' | 'callbacks' | 'statusLines'> {
  const reply = (context: CommandContext): Promise<void> => context.reply(NO_DATABASE_TEXT);
  const answer = (context: CallbackContext): Promise<void> => context.edit(NO_DATABASE_TEXT);
  return {
    commands: Object.entries(DESCRIPTIONS).map(([name, description]) => ({
      name,
      description,
      handler: reply,
    })),
    callbacks: [APPROVAL_PREFIX, KILL_SWITCH_PREFIX, 'jr', 'hs'].map((prefix) => ({
      prefix,
      handler: answer,
    })),
    statusLines: () => Promise.resolve(['⚪ База данных не подключена: пульт недоступен']),
  };
}

/** The owner command center (13b): approvals, kill switch, journal, history, digest. */
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

  const journal = (kind: JournalKind): BotCommandDefinition => ({
    name: kind,
    description: DESCRIPTIONS[kind],
    handler: (context) => context.reply(choosePeriodText(kind), periodKeyboard(kind)),
  });
  const journalButton = (kind: JournalKind): CallbackHandlerDefinition => ({
    prefix: callbackPrefix(kind),
    handler: async (context) => {
      if (!isPeriod(context.data)) {
        await context.answer('Кнопка устарела');
        return;
      }
      const text = await journalText(database.events, kind, context.data, nowMs());
      await context.edit(text, periodKeyboard(kind, context.data));
    },
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
      {
        name: 'decisions',
        description: DESCRIPTIONS.decisions,
        handler: (context) =>
          sendDecisionCards(deps, (text, keyboard) => context.reply(text, keyboard)),
      },
      { name: 'stop', description: DESCRIPTIONS.stop, handler: killSwitch.stop },
      { name: 'resume', description: DESCRIPTIONS.resume, handler: killSwitch.resume },
      journal('journal'),
      journal('history'),
      {
        name: 'digest',
        description: DESCRIPTIONS.digest,
        handler: async (context) => context.reply(await buildDigest(database, nowMs())),
      },
    ],
    callbacks: [
      { prefix: APPROVAL_PREFIX, handler: (context) => handleApprovalButton(deps, context) },
      { prefix: KILL_SWITCH_PREFIX, handler: killSwitch.handleButton },
      journalButton('journal'),
      journalButton('history'),
    ],
    async statusLines() {
      return [await killSwitchStatus(database.repositories, database.events)];
    },
    startDigest: () => scheduler.start(),
    stopDigest: () => scheduler.stop(),
  };
}
