import type {
  ActorType,
  Evidence,
  EvidenceId,
  PainId,
  SignalId,
  Timestamp,
} from '@roi-dealer/domain';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';
import { readRows } from './repository.js';
import { evidenceTable } from './tables.js';

export const SIGNAL_EXTRACTION_OUTCOMES = ['signal', 'no_pain', 'rejected', 'failed'] as const;
export type SignalExtractionOutcome = (typeof SIGNAL_EXTRACTION_OUTCOMES)[number];

/** How one Evidence was analyzed for pains (PHASE 06). Texts are never stored here. */
export interface SignalExtractionEntry {
  readonly evidenceId: EvidenceId;
  readonly taskVersion: number;
  readonly outcome: SignalExtractionOutcome;
  /** Present exactly for `signal`. */
  readonly signalId?: SignalId | undefined;
  /** The pain the signal joined or started. */
  readonly painId?: PainId | undefined;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly correlationId?: string | undefined;
}

export interface SignalExtractionCounts {
  readonly analyzed: number;
  readonly signals: number;
}

/** The journal of evidence analysis: only appended to (migration 0007). */
export interface SignalExtractionLog {
  /** Throws `ConstraintViolationError` (`signal_extractions_evidence_once`) for a repeat. */
  record(entry: SignalExtractionEntry): Promise<void>;
  /** Evidence not analyzed yet, oldest first; default 20, at most 200. */
  pending(options?: { readonly limit?: number | undefined }): Promise<Evidence[]>;
  /** Analyzed Evidence and created signals since `from`. */
  counts(from: Timestamp): Promise<SignalExtractionCounts>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export function createSignalExtractionLog(executor: Executor): SignalExtractionLog {
  return {
    record: (entry) =>
      translated(async () => {
        await executor`
          insert into signal_extractions (
            evidence_id, task_version, outcome, signal_id, pain_id, actor_type, actor_id,
            correlation_id
          ) values (
            ${entry.evidenceId}, ${entry.taskVersion}, ${entry.outcome}, ${entry.signalId ?? null},
            ${entry.painId ?? null}, ${entry.actorType}, ${entry.actorId},
            ${entry.correlationId ?? null}
          )
        `;
      }),

    pending: (options = {}) =>
      translated(async () => {
        const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
        const rows = await executor<Row[]>`
          select e.* from evidence e
          where not exists (select 1 from signal_extractions x where x.evidence_id = e.id)
          order by e.created_at, e.id
          limit ${limit}
        `;
        return readRows(executor, evidenceTable, rows);
      }),

    counts: (from) =>
      translated(async () => {
        const [row] = await executor<{ analyzed: string; signals: string }[]>`
          select count(*) as analyzed, count(*) filter (where outcome = 'signal') as signals
          from signal_extractions where occurred_at >= ${from}
        `;
        return { analyzed: Number(row?.analyzed ?? 0), signals: Number(row?.signals ?? 0) };
      }),
  };
}
