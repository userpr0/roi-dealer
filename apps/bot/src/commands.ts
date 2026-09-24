import type { HealthRegistry, HealthStatus } from '@roi-dealer/observability';
import type { BotCommandDefinition } from '@roi-dealer/telegram';

/** Owner-facing texts. All commands are read-only. */
export const TEXT = {
  help: [
    'Команды:',
    '/status — состояние системы',
    '/help — список команд',
    '',
    'Кнопка «Пульт» открывает панель управления.',
  ].join('\n'),
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
  readonly now?: () => number;
}

export function createBotCommands(deps: BotCommandsDeps): BotCommandDefinition[] {
  const now = deps.now ?? Date.now;

  return [
    {
      name: 'start',
      description: 'Начало работы с пультом',
      handler: (context) => context.reply(`👋 ROI Dealer — пульт владельца.\n\n${TEXT.help}`),
    },
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
