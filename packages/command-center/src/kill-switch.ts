import { randomBytes } from 'node:crypto';
import {
  AUTOMATION_CONTROL_ID,
  pauseSystem,
  resumeSystem,
  timestampMs,
  type Actor,
  type SystemControl,
  type Timestamp,
} from '@roi-dealer/domain';
import {
  DataIntegrityError,
  type Database,
  type EventStore,
  type Repositories,
} from '@roi-dealer/database';
import {
  callbackButton,
  type CallbackContext,
  type CommandContext,
  type InlineKeyboard,
} from '@roi-dealer/telegram';
import { actorLabel, formatTime } from './texts.js';

/** Buttons of the kill switch: `ks:y:<nonce>` confirms, `ks:n:<nonce>` cancels. */
export const KILL_SWITCH_PREFIX = 'ks';
/** A confirmation of /stop or /resume is valid this long (13b spec). */
export const CONFIRMATION_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;
const DEFAULT_REASON = 'Остановлено владельцем из пульта';
const MAX_REASON_LENGTH = 500;

type SwitchAction = 'pause' | 'resume';

interface PendingConfirmation {
  readonly action: SwitchAction;
  readonly reason?: string;
  readonly expiresAtMs: number;
}

/** The automation switch created by migration 0003. */
export async function loadAutomationControl(repositories: Repositories): Promise<SystemControl> {
  const control = await repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
  if (control === undefined) {
    throw new DataIntegrityError('system_control', AUTOMATION_CONTROL_ID, [
      { path: 'id', message: 'the automation switch is missing: apply migration 0003' },
    ]);
  }
  return control;
}

/** `▶️ Автоматизации: работают` or who paused them, when and why. */
export async function killSwitchStatus(
  repositories: Repositories,
  events: EventStore,
): Promise<string> {
  const control = await loadAutomationControl(repositories);
  if (control.status === 'running') return '▶️ Автоматизации: работают';
  const history = await events.history({ type: 'system_control', id: control.id });
  const pausedBy = history.at(-1)?.actor;
  return [
    `🛑 Автоматизации: на паузе с ${formatTime(control.updatedAt)}` +
      (pausedBy === undefined ? '' : ` (${actorLabel(pausedBy)})`),
    `Причина: ${control.reason ?? '—'}`,
  ].join('\n');
}

type SwitchOutcome =
  | { readonly outcome: 'changed'; readonly status: SystemControl['status'] }
  | { readonly outcome: 'unchanged'; readonly status: SystemControl['status'] };

export interface KillSwitchDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
}

export interface KillSwitchFlow {
  /** /stop [reason] */
  readonly stop: (context: CommandContext) => Promise<void>;
  /** /resume */
  readonly resume: (context: CommandContext) => Promise<void>;
  readonly handleButton: (context: CallbackContext) => Promise<void>;
}

/**
 * /stop and /resume change state, so each asks for confirmation first. The confirmation
 * (with the reason, which does not fit into button data) is kept in memory for 10 minutes;
 * after a restart the owner simply repeats the command.
 */
export function createKillSwitchFlow(deps: KillSwitchDeps): KillSwitchFlow {
  const pending = new Map<string, PendingConfirmation>();
  const nowMs = (): number => timestampMs(deps.now());

  function remember(confirmation: Omit<PendingConfirmation, 'expiresAtMs'>): string {
    const current = nowMs();
    for (const [nonce, entry] of pending) {
      if (entry.expiresAtMs <= current) pending.delete(nonce);
    }
    while (pending.size >= MAX_PENDING) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
    const nonce = randomBytes(8).toString('hex');
    pending.set(nonce, { ...confirmation, expiresAtMs: current + CONFIRMATION_TTL_MS });
    return nonce;
  }

  function confirmKeyboard(nonce: string, label: string): InlineKeyboard {
    return [
      [
        callbackButton(label, `${KILL_SWITCH_PREFIX}:y:${nonce}`),
        callbackButton('Отмена', `${KILL_SWITCH_PREFIX}:n:${nonce}`),
      ],
    ];
  }

  const status = (): Promise<string> =>
    killSwitchStatus(deps.database.repositories, deps.database.events);

  return {
    async stop(context) {
      const reason = context.args.replace(/\s+/g, ' ').trim() || DEFAULT_REASON;
      if (reason.length > MAX_REASON_LENGTH) {
        await context.reply(`Причина длиннее ${MAX_REASON_LENGTH} символов. Сократите её.`);
        return;
      }
      const control = await loadAutomationControl(deps.database.repositories);
      if (control.status === 'paused') {
        await context.reply(`${await status()}\n\n/resume — возобновить.`);
        return;
      }
      const nonce = remember({ action: 'pause', reason });
      await context.reply(
        `🛑 Остановить все автоматизации и автоматические траты?\nПричина: ${reason}\n\n` +
          'Подтверждение действует 10 минут.',
        confirmKeyboard(nonce, '🛑 Да, остановить'),
      );
    },

    async resume(context) {
      const control = await loadAutomationControl(deps.database.repositories);
      if (control.status === 'running') {
        await context.reply('▶️ Автоматизации уже работают.');
        return;
      }
      const nonce = remember({ action: 'resume' });
      await context.reply(
        `▶️ Возобновить автоматизации?\n${await status()}\n\nПодтверждение действует 10 минут.`,
        confirmKeyboard(nonce, '▶️ Да, возобновить'),
      );
    },

    async handleButton(context) {
      const [answer, nonce] = context.data.split(':');
      const confirmation = nonce === undefined ? undefined : pending.get(nonce);
      if (answer === 'n' && nonce !== undefined) {
        pending.delete(nonce);
        await context.edit('Отменено. Ничего не изменилось.');
        return;
      }
      if (answer !== 'y' || confirmation === undefined || confirmation.expiresAtMs <= nowMs()) {
        await context.edit(
          `⌛ Подтверждение устарело. Повторите /stop или /resume.\n\nСейчас:\n${await status()}`,
        );
        return;
      }

      const actor = deps.owner(context.userId);
      const { result } = await deps.database.command(
        {
          name: confirmation.action === 'pause' ? 'system.pause' : 'system.resume',
          idempotencyKey: `tg-callback-${context.callbackQueryId}`,
          correlationId: `tg-update-${context.updateId}`,
        },
        async ({ repositories }): Promise<SwitchOutcome> => {
          const control = await loadAutomationControl(repositories);
          const target = confirmation.action === 'pause' ? 'paused' : 'running';
          if (control.status === target) return { outcome: 'unchanged', status: control.status };
          const at = deps.now();
          const next =
            confirmation.action === 'pause'
              ? pauseSystem(control, confirmation.reason ?? DEFAULT_REASON, { actor, at })
              : resumeSystem(control, { actor, at });
          await repositories.systemControls.update(next, actor);
          return { outcome: 'changed', status: next.status };
        },
      );
      if (nonce !== undefined) pending.delete(nonce);

      context.logger.info('automation kill switch confirmed by the owner', {
        action: confirmation.action,
        outcome: result.outcome,
      });
      const done =
        result.status === 'paused'
          ? `🛑 Автоматизации остановлены.\n${await status()}\n\n/resume — возобновить.`
          : '▶️ Автоматизации возобновлены.';
      await context.edit(result.outcome === 'changed' ? done : `Уже так.\n${await status()}`);
    },
  };
}
