import { z } from 'zod';
import {
  experimentIdSchema,
  hypothesisIdSchema,
  text,
  timestampSchema,
  type Metric,
} from './primitives.js';

/*
 * The one funnel every experiment reports (D-014 п.9, playbook §7.1 Step G, ADR-0007), in
 * order. A success metric is a count of one stage or a stage as a share of an earlier one, so
 * the metric of any test is computed the same way from the funnel totals (§7.3).
 */

export const FUNNEL_STAGES = [
  'impression',
  'attention',
  'cta_click',
  'activation',
  /** A lead, sign-up or trial. */
  'lead',
  'payment',
  'product_use',
  'outcome',
  'retention',
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** `owner_report`: numbers the owner reads from a platform; `tracker`: events of own pages. */
export const FUNNEL_SOURCES = ['owner_report', 'tracker'] as const;
export type FunnelSource = (typeof FUNNEL_SOURCES)[number];

export const MAX_EVENT_QUANTITY = 1_000_000;

const utmValue = z.string().trim().min(1).max(100);
export const utmSchema = z.strictObject({
  source: utmValue.optional(),
  medium: utmValue.optional(),
  campaign: utmValue.optional(),
  content: utmValue.optional(),
  term: utmValue.optional(),
});

/** One funnel event (or a reported batch of identical events), the same for every test. */
export const funnelEventSchema = z.strictObject({
  experimentId: experimentIdSchema,
  hypothesisId: hypothesisIdSchema,
  stage: z.enum(FUNNEL_STAGES),
  quantity: z.int().min(1).max(MAX_EVENT_QUANTITY),
  channel: text(100),
  utm: utmSchema,
  /** UTC. */
  occurredAt: timestampSchema,
  source: z.enum(FUNNEL_SOURCES),
});
export type FunnelEvent = z.infer<typeof funnelEventSchema>;

/** Events per stage; a missing stage has none. */
export type FunnelTotals = Readonly<Partial<Record<FunnelStage, number>>>;

/** A count of `stage`, or `stage` as a percentage of the earlier stage `per`. */
export interface FunnelMeasure {
  readonly stage: FunnelStage;
  readonly per?: FunnelStage | undefined;
}

export const COUNT_UNIT = 'count';
export const RATE_UNIT = '%';

export function isFunnelStage(value: string | undefined): value is FunnelStage {
  return value !== undefined && (FUNNEL_STAGES as readonly string[]).includes(value);
}

const position = (stage: FunnelStage): number => FUNNEL_STAGES.indexOf(stage);

/** Whether `per` comes before `stage` in the funnel (a rate needs an earlier base). */
export function isEarlierStage(per: FunnelStage, stage: FunnelStage): boolean {
  return position(per) < position(stage);
}

/** The metric that measures `measure`: a whole count, or a percentage up to 100. */
export function funnelMetric(measure: FunnelMeasure, target: number): Metric {
  return measure.per === undefined
    ? { name: measure.stage, target, unit: COUNT_UNIT, direction: 'at_least' }
    : { name: `${measure.stage}/${measure.per}`, target, unit: RATE_UNIT, direction: 'at_least' };
}

/** What the funnel measures for this metric, or `undefined` when it is not a funnel metric. */
export function readFunnelMeasure(metric: Metric): FunnelMeasure | undefined {
  if (metric.direction !== 'at_least' || !(metric.target > 0)) return undefined;
  const [stage, per, extra] = metric.name.split('/');
  if (extra !== undefined || !isFunnelStage(stage)) return undefined;
  if (per === undefined) return metric.unit === COUNT_UNIT ? { stage } : undefined;
  if (!isFunnelStage(per) || !isEarlierStage(per, stage)) return undefined;
  return metric.unit === RATE_UNIT && metric.target <= 100 ? { stage, per } : undefined;
}

/**
 * The metric's value from the funnel totals, deterministic (§7.3): the count of the stage, or
 * its percentage of the base rounded to hundredths; `undefined` while a rate has no base.
 */
export function metricValue(metric: Metric, totals: FunnelTotals): number | undefined {
  const measure = readFunnelMeasure(metric);
  if (measure === undefined) return undefined;
  const count = totals[measure.stage] ?? 0;
  if (measure.per === undefined) return count;
  const base = totals[measure.per] ?? 0;
  return base === 0 ? undefined : Math.round((count / base) * 10_000) / 100;
}

export function metricReached(metric: Metric, value: number | undefined): boolean {
  return value !== undefined && value >= metric.target;
}
