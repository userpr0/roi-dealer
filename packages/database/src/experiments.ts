import {
  DomainError,
  funnelEventSchema,
  needsPrincipal,
  usd,
  type Actor,
  type ExperimentId,
  type FunnelEvent,
  type FunnelStage,
  type FunnelTotals,
  type Money,
} from '@roi-dealer/domain';
import { decideAccess, type Permission } from '@roi-dealer/policies';
import { uuidv7 } from '@roi-dealer/shared';
import { findPrincipal } from './access.js';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';

/*
 * The funnel of experiments (PHASE 15, migration 0012, ADR-0007): one append-only schema for
 * every test, and the deterministic sums the success metric and the stop-loss are computed from
 * (§7.3) — events per stage and the money spent on each experiment.
 */

export interface FunnelLog {
  /**
   * Appends the events (validated by the domain schema) as `actor`: events of own pages
   * (`tracker`) need `funnel.track`, every other event `experiment.write`; a member, agent or
   * integration also needs an active principal. Throws `ConstraintViolationError` when an
   * event names a hypothesis other than its experiment's.
   */
  record(events: readonly FunnelEvent[], actor: Actor, correlationId?: string): Promise<void>;
  /** Events per stage of each experiment; an experiment without events is absent. */
  totals(ids: readonly ExperimentId[]): Promise<ReadonlyMap<ExperimentId, FunnelTotals>>;
  /** Money spent on each experiment: its cost entries without refunds, reversals subtracted. */
  spent(ids: readonly ExperimentId[]): Promise<ReadonlyMap<ExperimentId, Money>>;
}

export function createFunnelLog(executor: Executor): FunnelLog {
  return {
    record: (events, actor, correlationId) =>
      translated(async () => {
        const parsed = events.map((raw) => funnelEventSchema.parse(raw));
        const permissions = new Set<Permission>(
          parsed.map((event) => (event.source === 'tracker' ? 'funnel.track' : 'experiment.write')),
        );
        const principal = needsPrincipal(actor) ? await findPrincipal(executor, actor) : undefined;
        for (const permission of permissions) {
          const decision = decideAccess(actor, permission, principal);
          if (!decision.allowed) {
            throw new DomainError('permission_denied', `The ${actor.type} may not ${permission}`, {
              actor_type: actor.type,
              permission,
              reason: decision.reason,
            });
          }
        }
        for (const event of parsed) {
          await executor`
            insert into experiment_events (
              id, experiment_id, hypothesis_id, stage, quantity, channel, utm_source, utm_medium,
              utm_campaign, utm_content, utm_term, occurred_at, source, actor_type, actor_id,
              correlation_id
            ) values (
              ${uuidv7()}, ${event.experimentId}, ${event.hypothesisId}, ${event.stage},
              ${event.quantity}, ${event.channel}, ${event.utm.source ?? null},
              ${event.utm.medium ?? null}, ${event.utm.campaign ?? null},
              ${event.utm.content ?? null}, ${event.utm.term ?? null}, ${event.occurredAt},
              ${event.source}, ${actor.type}, ${actor.id}, ${correlationId ?? null}
            )
          `;
        }
      }),

    totals: (ids) =>
      translated(async () => {
        if (ids.length === 0) return new Map();
        const rows = await executor<Row[]>`
          select experiment_id, stage, sum(quantity)::bigint as total
          from experiment_events
          where experiment_id = any(${[...ids]}::uuid[])
          group by experiment_id, stage
        `;
        const result = new Map<ExperimentId, Partial<Record<FunnelStage, number>>>();
        for (const row of rows) {
          const id = row['experiment_id'] as ExperimentId;
          const totals = result.get(id) ?? {};
          totals[row['stage'] as FunnelStage] = Number(row['total']);
          result.set(id, totals);
        }
        return result;
      }),

    spent: (ids) =>
      translated(async () => {
        if (ids.length === 0) return new Map();
        const rows = await executor<Row[]>`
          select experiment_id,
            sum(case when reversal_of is null then amount_usd_cents else -amount_usd_cents end)::bigint
              as spent
          from cost_entries
          where experiment_id = any(${[...ids]}::uuid[]) and category <> 'refund'
          group by experiment_id
        `;
        return new Map(
          rows.map((row) => [row['experiment_id'] as ExperimentId, usd(Number(row['spent']))]),
        );
      }),
  };
}
