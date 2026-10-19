import {
  DomainError,
  needsPrincipal,
  usd,
  type Actor,
  type CostEntryId,
  type ExperimentId,
  type Money,
  type RevenueEntryId,
  type Timestamp,
} from '@roi-dealer/domain';
import { decideAccess } from '@roi-dealer/policies';
import { uuidv7 } from '@roi-dealer/shared';
import { findPrincipal } from './access.js';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';

/*
 * The journal of payment events (PHASE 20b, migration 0018, ADR-0009): what the provider's
 * signed webhooks brought, each exactly once, with the revenue or refund line it created. It
 * holds no personal data: order numbers and amounts only.
 */

export const PAYMENT_EVENT_KINDS = ['order', 'test_order', 'refund'] as const;
export type PaymentEventKind = (typeof PAYMENT_EVENT_KINDS)[number];

export interface PaymentEventEntry {
  readonly provider: 'lemonsqueezy';
  /** `order:<id>`, `test_order:<id>` or `refund:<id>:<cumulative cents>`. */
  readonly eventKey: string;
  readonly kind: PaymentEventKind;
  readonly orderId: string;
  readonly experimentId?: ExperimentId | undefined;
  readonly amount: Money;
  readonly revenueEntryId?: RevenueEntryId | undefined;
  readonly costEntryId?: CostEntryId | undefined;
  readonly receivedAt: Timestamp;
  readonly correlationId?: string | undefined;
}

export interface RecordedPaymentEvent extends PaymentEventEntry {
  readonly id: string;
}

export interface PaymentEventLog {
  /**
   * Appends the event as `actor` (`payment.record` and an active principal). Throws
   * `ConstraintViolationError` (`payment_events_once`) when the event was recorded before.
   */
  record(entry: PaymentEventEntry, actor: Actor): Promise<void>;
  /** Refunds recorded for the order so far. */
  refunded(provider: 'lemonsqueezy', orderId: string): Promise<Money>;
  /** Events received since `from`, oldest first (for the owner's notices). */
  since(from: Timestamp, limit?: number): Promise<RecordedPaymentEvent[]>;
}

function toEntry(row: Row): RecordedPaymentEvent {
  const optional = <T>(value: unknown): T | undefined =>
    value === null || value === undefined ? undefined : (value as T);
  return {
    id: String(row['id']),
    provider: 'lemonsqueezy',
    eventKey: String(row['event_key']),
    kind: row['kind'] as PaymentEventKind,
    orderId: String(row['order_id']),
    experimentId: optional<ExperimentId>(row['experiment_id']),
    amount: usd(Number(row['amount_usd_cents'])),
    revenueEntryId: optional<RevenueEntryId>(row['revenue_entry_id']),
    costEntryId: optional<CostEntryId>(row['cost_entry_id']),
    receivedAt: new Date(row['received_at'] as Date).toISOString() as Timestamp,
    correlationId: optional<string>(row['correlation_id']),
  };
}

export function createPaymentEventLog(executor: Executor): PaymentEventLog {
  return {
    record: (entry, actor) =>
      translated(async () => {
        const principal = needsPrincipal(actor) ? await findPrincipal(executor, actor) : undefined;
        const decision = decideAccess(actor, 'payment.record', principal);
        if (!decision.allowed) {
          throw new DomainError('permission_denied', `The ${actor.type} may not record payments`, {
            actor_type: actor.type,
            permission: 'payment.record',
            reason: decision.reason,
          });
        }
        await executor`
          insert into payment_events (
            id, provider, event_key, kind, order_id, experiment_id, amount_usd_cents,
            revenue_entry_id, cost_entry_id, received_at, actor_type, actor_id, correlation_id
          ) values (
            ${uuidv7()}, ${entry.provider}, ${entry.eventKey}, ${entry.kind}, ${entry.orderId},
            ${entry.experimentId ?? null}, ${entry.amount.amountCents},
            ${entry.revenueEntryId ?? null}, ${entry.costEntryId ?? null}, ${entry.receivedAt},
            ${actor.type}, ${actor.id}, ${entry.correlationId ?? null}
          )
        `;
      }),

    refunded: (provider, orderId) =>
      translated(async () => {
        const [row] = await executor<Row[]>`
          select coalesce(sum(amount_usd_cents), 0)::bigint as total from payment_events
          where provider = ${provider} and order_id = ${orderId} and kind = 'refund'
        `;
        return usd(Number(row?.['total'] ?? 0));
      }),

    since: (from, limit = 100) =>
      translated(async () => {
        const rows = await executor<Row[]>`
          select * from payment_events where received_at >= ${from}
          order by received_at, id limit ${limit}
        `;
        return rows.map(toEntry);
      }),
  };
}
