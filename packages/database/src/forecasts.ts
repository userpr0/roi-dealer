import type { ExperimentId, ForecastVerdict, LaunchSignals } from '@roi-dealer/domain';
import { translated } from './errors.js';
import type { Executor } from './executor.js';

/*
 * Forecast vs fact (phase 25, ADR-0013, migration 0022): the forecast of each test at its start
 * and its fact at the result. Numbers only, appended once each.
 */

export interface ForecastEntry {
  readonly experimentId: ExperimentId;
  readonly rulesVersion: number;
  readonly probability: number;
  readonly signals: LaunchSignals;
  readonly correlationId?: string | undefined;
}

export interface ForecastOutcomeEntry {
  readonly experimentId: ExperimentId;
  readonly reached: boolean;
  readonly metricValue?: number | undefined;
  readonly verdict: ForecastVerdict;
  readonly correlationId?: string | undefined;
}

export interface StoredForecast {
  readonly experimentId: ExperimentId;
  readonly rulesVersion: number;
  readonly probability: number;
  readonly verdict?: ForecastVerdict | undefined;
}

export interface ForecastJournal {
  /** Throws `ConstraintViolationError` (`forecasts_pkey`) for a second forecast of a test. */
  record(entry: ForecastEntry): Promise<void>;
  /**
   * The fact of a forecast test; false when the test has no forecast (it started before
   * phase 25). Throws `ConstraintViolationError` for a second fact.
   */
  recordOutcome(entry: ForecastOutcomeEntry): Promise<boolean>;
  /** Every forecast with its fact, oldest first: hundreds of tests, not millions (ADR-0013). */
  list(): Promise<StoredForecast[]>;
}

export function createForecastJournal(executor: Executor): ForecastJournal {
  return {
    record: (entry) =>
      translated(async () => {
        await executor`
          insert into forecasts (experiment_id, rules_version, probability, signals, correlation_id)
          values (
            ${entry.experimentId}, ${entry.rulesVersion}, ${entry.probability},
            ${executor.json({ ...entry.signals })}, ${entry.correlationId ?? null}
          )
        `;
      }),

    recordOutcome: (entry) =>
      translated(async () => {
        const rows = await executor`
          insert into forecast_outcomes (
            experiment_id, reached, metric_value, verdict, correlation_id
          )
          select ${entry.experimentId}, ${entry.reached}, ${entry.metricValue ?? null},
                 ${entry.verdict}, ${entry.correlationId ?? null}
          where exists (select 1 from forecasts where experiment_id = ${entry.experimentId})
          returning experiment_id
        `;
        return rows.length > 0;
      }),

    list: () =>
      translated(async () => {
        const rows = await executor<
          {
            experiment_id: ExperimentId;
            rules_version: number;
            probability: string;
            verdict: ForecastVerdict | null;
          }[]
        >`
          select f.experiment_id, f.rules_version, f.probability::text as probability, o.verdict
          from forecasts f
          left join forecast_outcomes o on o.experiment_id = f.experiment_id
          order by f.occurred_at, f.experiment_id
        `;
        return rows.map((row) => ({
          experimentId: row.experiment_id,
          rulesVersion: Number(row.rules_version),
          probability: Number(row.probability),
          ...(row.verdict === null ? {} : { verdict: row.verdict }),
        }));
      }),
  };
}
