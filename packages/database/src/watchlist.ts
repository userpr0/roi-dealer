import type { PainId } from '@roi-dealer/domain';
import { translated } from './errors.js';
import type { Executor } from './executor.js';

/* The owner's answers on the watchlist (phase 27, ADR-0013, migration 0025). */

export type WatchDecision = 'returned' | 'kept';

export interface WatchDecisionEntry {
  readonly painId: PainId;
  readonly echoPainId: PainId;
  readonly decision: WatchDecision;
  readonly signals: number;
  readonly actorId: string;
  readonly correlationId?: string | undefined;
}

export interface StoredWatchDecision {
  readonly decision: WatchDecision;
  readonly echoPainId: PainId;
  readonly signals: number;
}

export interface WatchlistQueries {
  decide(entry: WatchDecisionEntry): Promise<void>;
  /** The latest answer per cut pain. */
  decisions(): Promise<ReadonlyMap<PainId, StoredWatchDecision>>;
  /**
   * False rejections: returned pains whose similar pain later led to a confirmed hypothesis
   * of an opportunity built on it.
   */
  falseRejections(): Promise<number>;
}

export function createWatchlistQueries(executor: Executor): WatchlistQueries {
  return {
    decide: (entry) =>
      translated(async () => {
        await executor`
          insert into watch_decisions (pain_id, echo_pain_id, decision, signals, actor_id, correlation_id)
          values (${entry.painId}, ${entry.echoPainId}, ${entry.decision}, ${entry.signals},
                  ${entry.actorId}, ${entry.correlationId ?? null})
        `;
      }),

    decisions: () =>
      translated(async () => {
        const rows = await executor<
          { pain_id: PainId; echo_pain_id: PainId; decision: WatchDecision; signals: number }[]
        >`
          select distinct on (pain_id) pain_id, echo_pain_id, decision, signals
          from watch_decisions order by pain_id, id desc
        `;
        return new Map(
          rows.map((row) => [
            row.pain_id,
            { decision: row.decision, echoPainId: row.echo_pain_id, signals: Number(row.signals) },
          ]),
        );
      }),

    falseRejections: () =>
      translated(async () => {
        const [row] = await executor<{ count: string }[]>`
          select count(distinct w.pain_id)::text as count
          from watch_decisions w
          join opportunity_pains op on op.pain_id = w.echo_pain_id
          join hypotheses h on h.opportunity_id = op.opportunity_id and h.status = 'confirmed'
          where w.decision = 'returned'
        `;
        return Number(row?.count ?? 0);
      }),
  };
}
