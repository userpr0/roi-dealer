import type {
  ApprovalRequest,
  Contribution,
  CostEntry,
  Decision,
  Evidence,
  Experiment,
  Hypothesis,
  KnowledgeAsset,
  Opportunity,
  Pain,
  Reward,
  Signal,
  Source,
} from '@roi-dealer/domain';
import type { Executor } from './executor.js';
import {
  createRepository,
  createVersionedRepository,
  type Repository,
  type VersionedRepository,
  type WriteContext,
} from './repository.js';
import {
  approvalRequestsTable,
  contributionsTable,
  costEntriesTable,
  decisionsTable,
  evidenceTable,
  experimentsTable,
  hypothesesTable,
  knowledgeAssetsTable,
  opportunitiesTable,
  painsTable,
  rewardsTable,
  signalsTable,
  sourcesTable,
} from './tables.js';

/** One repository per PHASE 01 entity; append-only records have no `update`. */
export interface Repositories {
  readonly sources: VersionedRepository<Source>;
  readonly evidence: Repository<Evidence>;
  readonly signals: VersionedRepository<Signal>;
  readonly pains: VersionedRepository<Pain>;
  readonly opportunities: VersionedRepository<Opportunity>;
  readonly decisions: Repository<Decision>;
  readonly approvalRequests: VersionedRepository<ApprovalRequest>;
  readonly hypotheses: VersionedRepository<Hypothesis>;
  readonly experiments: VersionedRepository<Experiment>;
  readonly costEntries: Repository<CostEntry>;
  readonly contributions: VersionedRepository<Contribution>;
  readonly rewards: VersionedRepository<Reward>;
  readonly knowledgeAssets: Repository<KnowledgeAsset>;
}

/**
 * Repositories bound to the pool or to an open transaction. Every write appends its event
 * (PHASE 03) in the same transaction, with `context.correlationId`.
 */
export function createRepositories(executor: Executor, context: WriteContext = {}): Repositories {
  return {
    sources: createVersionedRepository(executor, sourcesTable, context),
    evidence: createRepository(executor, evidenceTable, context),
    signals: createVersionedRepository(executor, signalsTable, context),
    pains: createVersionedRepository(executor, painsTable, context),
    opportunities: createVersionedRepository(executor, opportunitiesTable, context),
    decisions: createRepository(executor, decisionsTable, context),
    approvalRequests: createVersionedRepository(executor, approvalRequestsTable, context),
    hypotheses: createVersionedRepository(executor, hypothesesTable, context),
    experiments: createVersionedRepository(executor, experimentsTable, context),
    costEntries: createRepository(executor, costEntriesTable, context),
    contributions: createVersionedRepository(executor, contributionsTable, context),
    rewards: createVersionedRepository(executor, rewardsTable, context),
    knowledgeAssets: createRepository(executor, knowledgeAssetsTable, context),
  };
}
