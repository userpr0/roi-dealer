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

/** Repositories bound to the pool or to an open transaction. */
export function createRepositories(executor: Executor): Repositories {
  return {
    sources: createVersionedRepository(executor, sourcesTable),
    evidence: createRepository(executor, evidenceTable),
    signals: createVersionedRepository(executor, signalsTable),
    pains: createVersionedRepository(executor, painsTable),
    opportunities: createVersionedRepository(executor, opportunitiesTable),
    decisions: createRepository(executor, decisionsTable),
    approvalRequests: createVersionedRepository(executor, approvalRequestsTable),
    hypotheses: createVersionedRepository(executor, hypothesesTable),
    experiments: createVersionedRepository(executor, experimentsTable),
    costEntries: createRepository(executor, costEntriesTable),
    contributions: createVersionedRepository(executor, contributionsTable),
    rewards: createVersionedRepository(executor, rewardsTable),
    knowledgeAssets: createRepository(executor, knowledgeAssetsTable),
  };
}
