import { toTimestamp } from '@roi-dealer/domain';
import type { CountedEntity, Database, Period, SearchHit } from '@roi-dealer/database';
import { searchBrain } from './search.js';

/*
 * ❓ Ask the system (PHASE 08, §7.3): code recognizes the question by fixed rules, runs a fixed
 * query and returns the facts with their source. No AI: no number can be made up, and the AI
 * keys stay in the worker (ADR-0006).
 */

export const PERIOD_KEYS = ['day', 'yesterday', 'week', 'month', 'all'] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

export type QuestionPlan =
  | { readonly kind: 'spend' | 'ai_spend' | 'news'; readonly period: PeriodKey }
  | { readonly kind: 'count'; readonly entity: CountedEntity; readonly period: PeriodKey }
  | { readonly kind: 'search'; readonly text: string };

const DAY_MS = 24 * 3_600_000;

const PERIOD_RULES: readonly (readonly [RegExp, PeriodKey])[] = [
  [/вчера|yesterday/, 'yesterday'],
  [/сегодня|сутки|за день|today|last day/, 'day'],
  [/недел|week/, 'week'],
  [/месяц|month/, 'month'],
  [/вс[её] время|всего|за всё|за все|all time|ever|total/, 'all'],
];
const ENTITY_RULES: readonly (readonly [RegExp, CountedEntity])[] = [
  [/возможност|opportunit/, 'opportunity'],
  [/сигнал|signal/, 'signal'],
  // `\b` is ASCII-only in JavaScript: Cyrillic word ends are spelled out.
  [/бол(ь|и|ей|ям|ях)(?![а-яё])|pain/, 'pain'],
  [/доказательств|evidence|пост/, 'evidence'],
  [/знани|заметк|knowledge|note/, 'knowledge'],
  [/решени|decision/, 'decision'],
];
const AI = /(^|[^a-zа-яё])(ai|ии)([^a-zа-яё]|$)|модел|нейросет|claude|gpt|gemini/;
const SPEND =
  /потрат|расход|затрат|стоил|стоит|стоимост|ушл[оаи](?![а-яё])|заплат|spend|spent|cost/;
const COUNT = /сколько|how many|количеств|число|count/;
const NEWS = /что нового|новое|новост|what'?s new|what is new/;

function periodOf(text: string): PeriodKey | undefined {
  return PERIOD_RULES.find(([pattern]) => pattern.test(text))?.[1];
}

/** The fixed query a question asks for; anything unrecognized becomes a search. */
export function planQuestion(question: string): QuestionPlan {
  const text = question.toLowerCase().replace(/\s+/g, ' ').trim();
  const period = periodOf(text);
  if (SPEND.test(text)) {
    return { kind: AI.test(text) ? 'ai_spend' : 'spend', period: period ?? 'month' };
  }
  if (NEWS.test(text)) return { kind: 'news', period: period ?? 'day' };
  const entity = ENTITY_RULES.find(([pattern]) => pattern.test(text))?.[1];
  if (entity !== undefined && COUNT.test(text)) {
    return { kind: 'count', entity, period: period ?? 'all' };
  }
  return { kind: 'search', text: question.trim() };
}

/** The time range of a period, counted back from `nowMs` (the last 24 hours, 7 or 30 days). */
export function periodRange(period: PeriodKey, nowMs: number): Period {
  const at = (ms: number) => toTimestamp(new Date(ms));
  switch (period) {
    case 'day':
      return { from: at(nowMs - DAY_MS), to: at(nowMs + 1) };
    case 'yesterday':
      return { from: at(nowMs - 2 * DAY_MS), to: at(nowMs - DAY_MS) };
    case 'week':
      return { from: at(nowMs - 7 * DAY_MS), to: at(nowMs + 1) };
    case 'month':
      return { from: at(nowMs - 30 * DAY_MS), to: at(nowMs + 1) };
    case 'all':
      return {};
  }
}

const NEWS_ENTITIES: readonly CountedEntity[] = [
  'evidence',
  'signal',
  'pain',
  'opportunity',
  'knowledge',
  'decision',
];

/** The facts that answer a question, each with where it comes from. */
export type QuestionAnswer =
  | {
      readonly kind: 'spend';
      readonly period: PeriodKey;
      readonly totalCents: number;
      readonly byCategory: Readonly<Record<string, number>>;
      readonly entries: number;
    }
  | {
      readonly kind: 'ai_spend';
      readonly period: PeriodKey;
      readonly costMicroUsd: number;
      readonly calls: number;
      readonly failed: number;
    }
  | {
      readonly kind: 'count';
      readonly entity: CountedEntity;
      readonly period: PeriodKey;
      readonly created: number;
      /** The current number by status, for entities that have one. */
      readonly byStatus?: Readonly<Record<string, number>> | undefined;
    }
  | {
      readonly kind: 'news';
      readonly period: PeriodKey;
      readonly created: Readonly<Record<CountedEntity, number>>;
    }
  | {
      readonly kind: 'search';
      readonly hits: readonly SearchHit[];
      readonly similar: boolean;
      readonly needsEnglish: boolean;
    };

/** Runs the fixed query of the question's plan (§7.3: retrieve, then answer). */
export async function answerQuestion(
  database: Pick<Database, 'brain' | 'aiCalls'>,
  question: string,
  nowMs: number,
): Promise<QuestionAnswer> {
  const plan = planQuestion(question);
  switch (plan.kind) {
    case 'spend': {
      const totals = await database.brain.costTotals(periodRange(plan.period, nowMs));
      return { kind: 'spend', period: plan.period, ...totals };
    }
    case 'ai_spend': {
      const spend = await database.aiCalls.spend(periodRange(plan.period, nowMs));
      return { kind: 'ai_spend', period: plan.period, ...spend };
    }
    case 'count': {
      const created = await database.brain.countCreated(
        plan.entity,
        periodRange(plan.period, nowMs),
      );
      const byStatus =
        plan.entity === 'pain' || plan.entity === 'opportunity' || plan.entity === 'signal'
          ? await database.brain.countByStatus(plan.entity)
          : undefined;
      return { kind: 'count', entity: plan.entity, period: plan.period, created, byStatus };
    }
    case 'news': {
      const range = periodRange(plan.period, nowMs);
      const created = {} as Record<CountedEntity, number>;
      for (const entity of NEWS_ENTITIES) {
        created[entity] = await database.brain.countCreated(entity, range);
      }
      return { kind: 'news', period: plan.period, created };
    }
    case 'search':
      return { kind: 'search', ...(await searchBrain(database, plan.text, { limit: 5 })) };
  }
}
