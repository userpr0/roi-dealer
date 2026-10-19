import {
  PRINCIPAL_STATUSES,
  toTimestamp,
  type Principal,
  type PrincipalStatus,
} from '@roi-dealer/domain';
import type { AgentRunOutcome, Database, StoredAgentRun } from '@roi-dealer/database';
import { formatMicroUsd } from './ai-status.js';
import { formatTime } from './texts.js';

const DAY_MS = 24 * 3_600_000;

const ACCESS_LABELS: Readonly<Record<PrincipalStatus, string>> = {
  active: '✅ работает',
  pending: '⏳ ждёт вашего решения в /decisions',
  suspended: '⏸ приостановлен (/access)',
  revoked: '⛔ доступ отозван',
};
const OUTCOME_LABELS: Readonly<Record<AgentRunOutcome, string>> = {
  done: 'обработано',
  idle: 'новой работы нет',
  no_access: 'нет доступа',
  stopped: 'остановлен',
  failed: '⚠️ сбой',
};
const STOP_LABELS: Readonly<Record<string, string>> = {
  budget: 'квота AI на сегодня',
  unavailable: 'AI недоступен',
  failed: 'все модели ответили с ошибкой',
};

export const NO_AGENTS_TEXT =
  '🤖 Агентов пока нет.\n\nАгенты появляются, когда worker запущен с ключами AI: каждый сначала ' +
  'просит доступ в /decisions.';

function lastRunText(run: StoredAgentRun | undefined): string {
  if (run === undefined) return 'ещё не запускался';
  const outcome =
    run.outcome === 'done'
      ? `${OUTCOME_LABELS.done} ${String(run.processed)}`
      : run.outcome === 'stopped'
        ? `${OUTCOME_LABELS.stopped}: ${STOP_LABELS[run.stoppedBy ?? ''] ?? 'причина неизвестна'}` +
          (run.processed > 0 ? `, обработано ${String(run.processed)}` : '')
        : OUTCOME_LABELS[run.outcome];
  return `${formatTime(run.startedAt)} — ${outcome}`;
}

/**
 * /agents (PHASE 10): every agent that asked for access — its access, its last run and the last
 * 24 hours (runs, objects worked on, AI cost by its actor). From the database only (§2.13).
 */
export async function agentsText(
  database: Pick<Database, 'repositories' | 'agentRuns' | 'aiCalls'>,
  nowMs: number,
): Promise<string> {
  const agents: Principal[] = [];
  for (const status of PRINCIPAL_STATUSES) {
    const principals = await database.repositories.principals.listByStatus(status, {
      limit: 1_000,
    });
    agents.push(...principals.filter((principal) => principal.actor.type === 'agent'));
  }
  if (agents.length === 0) return NO_AGENTS_TEXT;
  agents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const from = toTimestamp(new Date(nowMs - DAY_MS));
  const to = toTimestamp(new Date(nowMs + 1));
  const [latest, totals] = await Promise.all([
    database.agentRuns.latest(),
    database.agentRuns.totals(from),
  ]);
  const lines = [`🤖 Агенты · ${String(agents.length)}`, ''];
  let dayCost = 0;
  for (const agent of agents) {
    const key = agent.actor.id;
    const day = totals.get(key);
    const spend = await database.aiCalls.spend({ from, to, actorId: key, purpose: 'task' });
    dayCost += spend.costMicroUsd;
    lines.push(
      `${agent.displayName} — ${ACCESS_LABELS[agent.status]}`,
      `   Последний запуск: ${lastRunText(latest.get(key))}`,
      `   За сутки: запусков ${String(day?.runs ?? 0)}, обработано ${String(day?.processed ?? 0)}` +
        ((day?.failed ?? 0) > 0 ? `, сбоев ${String(day?.failed ?? 0)}` : '') +
        ` · AI ${formatMicroUsd(spend.costMicroUsd)}`,
    );
  }
  lines.push(
    '',
    `AI агентов за сутки: ${formatMicroUsd(dayCost)}. Квота дня и месяц — /status; доступы — /access.`,
  );
  return lines.join('\n');
}
