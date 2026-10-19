import type {
  Actor,
  ApprovalRequest,
  Contribution,
  CostEntry,
  Decision,
  Evidence,
  Experiment,
  Hypothesis,
  KnowledgeAsset,
  Opportunity,
  OpportunityId,
  Pain,
  Principal,
  RevenueEntry,
  Reward,
  Signal,
  Source,
  SourceId,
  SourceSnapshot,
  SystemControl,
} from '@roi-dealer/domain';
import { findPrincipal } from './access.js';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';
import {
  createRepository,
  createVersionedRepository,
  readRows,
  type Repository,
  type VersionedRepository,
  type WriteContext,
} from './repository.js';
import {
  approvalRequestsTable,
  contributionsTable,
  costEntriesTable,
  revenueEntriesTable,
  decisionsTable,
  evidenceTable,
  experimentsTable,
  hypothesesTable,
  knowledgeAssetsTable,
  opportunitiesTable,
  painsTable,
  principalsTable,
  rewardsTable,
  signalsTable,
  sourceSnapshotsTable,
  sourcesTable,
  systemControlsTable,
} from './tables.js';

/** One repository per domain entity; append-only records have no `update`. */
export interface Repositories {
  readonly sources: SourceRepository;
  readonly evidence: EvidenceRepository;
  readonly signals: VersionedRepository<Signal>;
  readonly pains: VersionedRepository<Pain>;
  readonly opportunities: VersionedRepository<Opportunity>;
  readonly decisions: Repository<Decision>;
  readonly approvalRequests: VersionedRepository<ApprovalRequest>;
  readonly hypotheses: HypothesisRepository;
  readonly experiments: VersionedRepository<Experiment>;
  readonly costEntries: Repository<CostEntry>;
  /** The revenue ledger (PHASE 16). */
  readonly revenueEntries: Repository<RevenueEntry>;
  readonly contributions: VersionedRepository<Contribution>;
  readonly rewards: VersionedRepository<Reward>;
  readonly knowledgeAssets: KnowledgeAssetRepository;
  /** The automation kill switch (13b); its row is created by migration 0003. */
  readonly systemControls: VersionedRepository<SystemControl>;
  /** Identities of members, agents and integrations (PHASE 04). */
  readonly principals: PrincipalRepository;
  /** Loads from catalog sources (PHASE 05). */
  readonly sourceSnapshots: Repository<SourceSnapshot>;
}

export interface SourceRepository extends VersionedRepository<Source> {
  /** The source connected by this catalog entry (PHASE 05), whatever its status. */
  getByCatalogKey(catalogKey: string): Promise<Source | undefined>;
}

export interface KnowledgeAssetRepository extends Repository<KnowledgeAsset> {
  /** Assets carrying every one of `tags`, newest first (e.g. eval reports, PHASE 09). */
  listByTags(
    tags: readonly string[],
    options?: {
      readonly limit?: number;
      /** Only assets linked to one of these opportunities (PHASE 10). */
      readonly opportunityIds?: readonly OpportunityId[];
    },
  ): Promise<KnowledgeAsset[]>;
}

export interface HypothesisRepository extends VersionedRepository<Hypothesis> {
  /** The hypotheses of these opportunities, oldest first (PHASE 14). */
  listByOpportunities(ids: readonly OpportunityId[]): Promise<Hypothesis[]>;
}

export interface EvidenceRepository extends Repository<Evidence> {
  /** Which of `externalIds` are already stored for the source (repeated collection, PHASE 05). */
  knownExternalIds(sourceId: SourceId, externalIds: readonly string[]): Promise<Set<string>>;
}

export interface PrincipalRepository extends VersionedRepository<Principal> {
  /** The identity registered for this actor, whatever its status. */
  getByActor(actor: Actor): Promise<Principal | undefined>;
}

/**
 * Repositories bound to the pool or to an open transaction. Every write appends its event
 * (PHASE 03) in the same transaction, with `context.correlationId`.
 */
export function createRepositories(executor: Executor, context: WriteContext = {}): Repositories {
  return {
    sources: {
      ...createVersionedRepository(executor, sourcesTable, context),
      getByCatalogKey: (catalogKey) =>
        translated(async () => {
          const rows = await executor<Row[]>`
            select * from sources where catalog_key = ${catalogKey}
          `;
          const [source] = await readRows(executor, sourcesTable, rows);
          return source;
        }),
    },
    evidence: {
      ...createRepository(executor, evidenceTable, context),
      knownExternalIds: (sourceId, externalIds) =>
        translated(async () => {
          if (externalIds.length === 0) return new Set<string>();
          const rows = await executor<{ external_id: string }[]>`
            select external_id from evidence
            where source_id = ${sourceId} and external_id = any(${externalIds}::text[])
          `;
          return new Set(rows.map((row) => row.external_id));
        }),
    },
    signals: createVersionedRepository(executor, signalsTable, context),
    pains: createVersionedRepository(executor, painsTable, context),
    opportunities: createVersionedRepository(executor, opportunitiesTable, context),
    decisions: createRepository(executor, decisionsTable, context),
    approvalRequests: createVersionedRepository(executor, approvalRequestsTable, context),
    hypotheses: {
      ...createVersionedRepository(executor, hypothesesTable, context),
      listByOpportunities: (ids) =>
        translated(async () => {
          if (ids.length === 0) return [];
          const rows = await executor<Row[]>`
            select * from hypotheses where opportunity_id = any(${[...ids]}::uuid[])
            order by created_at, id
          `;
          return readRows(executor, hypothesesTable, rows);
        }),
    },
    experiments: createVersionedRepository(executor, experimentsTable, context),
    costEntries: createRepository(executor, costEntriesTable, context),
    revenueEntries: createRepository(executor, revenueEntriesTable, context),
    contributions: createVersionedRepository(executor, contributionsTable, context),
    rewards: createVersionedRepository(executor, rewardsTable, context),
    knowledgeAssets: {
      ...createRepository(executor, knowledgeAssetsTable, context),
      listByTags: (tags, options = {}) =>
        translated(async () => {
          const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 1_000);
          const rows = await executor<Row[]>`
            select * from knowledge_assets where tags @> ${[...tags]}::text[]
            ${
              options.opportunityIds === undefined
                ? executor``
                : executor`and opportunity_id = any(${[...options.opportunityIds]}::uuid[])`
            }
            order by created_at desc, id desc
            limit ${limit}
          `;
          return readRows(executor, knowledgeAssetsTable, rows);
        }),
    },
    systemControls: createVersionedRepository(executor, systemControlsTable, context),
    principals: {
      ...createVersionedRepository(executor, principalsTable, context),
      getByActor: (actor) => translated(() => findPrincipal(executor, actor)),
    },
    sourceSnapshots: createRepository(executor, sourceSnapshotsTable, context),
  };
}
