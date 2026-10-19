import {
  AI_BUDGET_LIMITS,
  dailyAiAllowanceMicroUsd,
  startOfUtcDay,
  startOfUtcMonth,
  toTimestamp,
} from '@roi-dealer/domain';
import type { AiCallLog, AiProvider } from '@roi-dealer/database';
import { formatTime } from './texts.js';

const PROVIDER_LABELS: Readonly<Record<AiProvider, string>> = {
  anthropic: 'Claude',
  openai: 'GPT',
  google: 'Gemini',
};
const DAY_MS = 24 * 3_600_000;
const iso = (ms: number) => toTimestamp(new Date(ms));

/** `$0.42`; amounts under a cent as `<$0.01`. */
export function formatMicroUsd(micro: number): string {
  if (micro === 0) return '$0';
  if (micro < 10_000) return '<$0.01';
  return `$${(micro / 1_000_000).toFixed(2)}`;
}

/**
 * /status: today's spend against today's allowance (D-021: the rest of the month over the days
 * left), the month against $50 (D-007) and the last successful call per provider.
 */
export async function aiStatusLine(aiCalls: AiCallLog, nowMs: number): Promise<string> {
  const dayStart = startOfUtcDay(nowMs);
  const [beforeToday, today, last] = await Promise.all([
    aiCalls.spend({ from: iso(startOfUtcMonth(nowMs)), to: iso(dayStart) }),
    aiCalls.spend({ from: iso(dayStart), to: iso(dayStart + DAY_MS) }),
    aiCalls.lastSuccess(),
  ]);
  if (beforeToday.calls + today.calls === 0 && Object.keys(last).length === 0) {
    return '🤖 AI: вызовов ещё не было';
  }
  const allowance = dailyAiAllowanceMicroUsd(AI_BUDGET_LIMITS, beforeToday.costMicroUsd, nowMs);
  const month = beforeToday.costMicroUsd + today.costMicroUsd;
  const providers = (Object.keys(PROVIDER_LABELS) as AiProvider[]).map((provider) => {
    const at = last[provider];
    return `${PROVIDER_LABELS[provider]} ${at === undefined ? '—' : `✓ ${formatTime(at)}`}`;
  });
  return (
    `🤖 AI сегодня: ${formatMicroUsd(today.costMicroUsd)} из ${formatMicroUsd(allowance)}` +
    ` · за месяц ${formatMicroUsd(month)} из ${formatMicroUsd(AI_BUDGET_LIMITS.monthlyMicroUsd)}` +
    `\n${providers.join(' · ')}`
  );
}

/** Digest: AI spend of the last 24 hours, when there were calls. */
export async function aiDigestLine(aiCalls: AiCallLog, nowMs: number): Promise<string | undefined> {
  const day = await aiCalls.spend({ from: iso(nowMs - DAY_MS), to: iso(nowMs + 1) });
  if (day.calls === 0) return undefined;
  const failed = day.failed === 0 ? '' : `, с ошибкой ${String(day.failed)}`;
  return `🤖 AI за сутки: ${formatMicroUsd(day.costMicroUsd)} · вызовов ${String(day.calls)}${failed}`;
}
