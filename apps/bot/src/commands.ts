import type { HealthRegistry, HealthStatus, Logger } from '@roi-dealer/observability';
import type { BotCommandDefinition } from '@roi-dealer/telegram';

/**
 * Owner-facing texts. /status and /help are read-only; the command center commands that change
 * state (decisions, /stop, /resume) always ask for confirmation first.
 */
export const TEXT = {
  help: [
    'Команды:',
    '/decisions — решения, которые ждут вас',
    '/stop [причина] — стоп-кран: остановить автоматизации',
    '/resume — возобновить автоматизации',
    '/journal — журнал изменений за день, неделю, месяц',
    '/history — история решений и денег',
    '/digest — дайджест сейчас (каждый день приходит в 10:00 по Киеву)',
    '/status — состояние системы',
    '/help — список команд',
    '',
    'Одобрение и стоп-кран выполняются только после подтверждения кнопкой.',
    'Кнопка «Пульт» открывает панель управления.',
  ].join('\n'),
  unknownButton: 'Кнопка устарела. Повторите команду.',
  unknownCommand: 'Неизвестная команда. /help — список команд.',
  failure: '⚠️ Не удалось выполнить команду. Подробности в логах сервиса.',
  stopped: '🔴 ROI Dealer bot остановлен',
} as const;

const STATUS_ICON: Readonly<Record<HealthStatus, string>> = {
  ok: '🟢',
  degraded: '🟡',
  down: '🔴',
};

/** Human-readable uptime in Russian: `<1 мин`, `14 мин`, `2 ч 5 мин`, `3 д 4 ч`. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1 мин';
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} д ${hours} ч` : `${days} д`;
  if (hours > 0) return mins > 0 ? `${hours} ч ${mins} мин` : `${hours} ч`;
  return `${mins} мин`;
}

export interface RuntimeInfo {
  readonly version: string;
  readonly environment: string;
}

export function startedText(info: RuntimeInfo): string {
  return `🟢 ROI Dealer bot запущен\nВерсия: ${info.version}\nОкружение: ${info.environment}`;
}

export interface BotCommandsDeps extends RuntimeInfo {
  readonly health: HealthRegistry;
  readonly startedAt: number;
  /** Command center commands, listed in the menu before /status and /help. */
  readonly panel?: readonly BotCommandDefinition[];
  /** Extra /status lines (the kill switch). */
  readonly statusLines?: () => Promise<string[]>;
  readonly now?: () => number;
}

export function createBotCommands(deps: BotCommandsDeps): BotCommandDefinition[] {
  const now = deps.now ?? Date.now;

  /** The database may be down: /status still answers and shows the failed check. */
  async function statusLines(logger: Logger): Promise<string[]> {
    if (deps.statusLines === undefined) return [];
    try {
      return await deps.statusLines();
    } catch (error) {
      logger.warn('kill switch state unavailable for /status', { error });
      return ['⚠️ Стоп-кран: состояние недоступно'];
    }
  }

  return [
    {
      name: 'start',
      description: 'Начало работы с пультом',
      handler: (context) => context.reply(`👋 ROI Dealer — пульт владельца.\n\n${TEXT.help}`),
    },
    ...(deps.panel ?? []),
    {
      name: 'status',
      description: 'Состояние системы',
      handler: async (context) => {
        const report = await deps.health.run();
        const lines = [
          `${STATUS_ICON[report.status]} ROI Dealer: ${report.status}`,
          `Сервис: ${report.service}`,
          `Версия: ${deps.version}`,
          `Окружение: ${deps.environment}`,
          `Работает: ${formatDuration(now() - deps.startedAt)}`,
          ...Object.entries(report.checks ?? {}).map(
            ([name, check]) => `${STATUS_ICON[check.status]} ${name}: ${check.status}`,
          ),
          ...(await statusLines(context.logger)),
        ];
        await context.reply(lines.join('\n'));
      },
    },
    {
      name: 'help',
      description: 'Список команд',
      handler: (context) => context.reply(TEXT.help),
    },
  ];
}
