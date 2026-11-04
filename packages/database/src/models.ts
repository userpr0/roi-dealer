import type { AiProvider } from './ai-calls.js';
import { translated } from './errors.js';
import type { Executor } from './executor.js';

/*
 * Model changes by tests (09b, ADR-0014, migration 0024): the owner's decisions on candidate
 * models and the model ids the providers list.
 */

export type ModelDecision = 'admitted' | 'rejected';

export interface ModelAdmissionEntry {
  readonly modelId: string;
  readonly decision: ModelDecision;
  readonly actorId: string;
  readonly correlationId?: string | undefined;
}

export interface ListedModel {
  readonly provider: AiProvider;
  readonly modelId: string;
  readonly firstSeenAt: string;
}

export interface ModelQueries {
  decide(entry: ModelAdmissionEntry): Promise<void>;
  /** The latest decision per model. */
  decisions(): Promise<ReadonlyMap<string, ModelDecision>>;
  /**
   * Records the ids a provider lists now. The first list of a provider is the baseline; returns
   * the ids that were never seen before and are not part of it.
   */
  recordListed(provider: AiProvider, ids: readonly string[]): Promise<string[]>;
  /** Ids seen after the baseline, newest first (at most 50). */
  newModels(): Promise<ListedModel[]>;
}

export function createModelQueries(executor: Executor): ModelQueries {
  return {
    decide: (entry) =>
      translated(async () => {
        await executor`
          insert into model_admissions (model_id, decision, actor_id, correlation_id)
          values (${entry.modelId}, ${entry.decision}, ${entry.actorId}, ${entry.correlationId ?? null})
        `;
      }),

    decisions: () =>
      translated(async () => {
        const rows = await executor<{ model_id: string; decision: ModelDecision }[]>`
          select distinct on (model_id) model_id, decision from model_admissions
          order by model_id, id desc
        `;
        return new Map(rows.map((row) => [row.model_id, row.decision]));
      }),

    recordListed: (provider, ids) =>
      translated(async () => {
        const unique = [...new Set(ids)].filter((id) => id.length > 0 && id.length <= 100);
        if (unique.length === 0) return [];
        const [known] = await executor<{ count: string }[]>`
          select count(*)::text as count from provider_models where provider = ${provider}
        `;
        const baseline = Number(known?.count ?? 0) === 0;
        const rows = await executor<{ model_id: string }[]>`
          insert into provider_models (provider, model_id, baseline)
          select ${provider}, id, ${baseline} from unnest(${unique}::text[]) as id
          on conflict (provider, model_id) do nothing
          returning model_id
        `;
        return baseline ? [] : rows.map((row) => row.model_id).sort();
      }),

    newModels: () =>
      translated(async () => {
        const rows = await executor<
          { provider: AiProvider; model_id: string; first_seen_at: Date }[]
        >`
          select provider, model_id, first_seen_at from provider_models
          where not baseline
          order by first_seen_at desc, model_id
          limit 50
        `;
        return rows.map((row) => ({
          provider: row.provider,
          modelId: row.model_id,
          firstSeenAt: row.first_seen_at.toISOString(),
        }));
      }),
  };
}
