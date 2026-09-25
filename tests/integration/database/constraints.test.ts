import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changeHypothesisStatus,
  createEvidence,
  createExperiment,
  createHypothesis,
  createOpportunity,
  createPain,
  createSignal,
  createSource,
  evidenceIdSchema,
  experimentIdSchema,
  hypothesisIdSchema,
  opportunityIdSchema,
  painIdSchema,
  signalIdSchema,
  sourceIdSchema,
  type Evidence,
  type Experiment,
  type Hypothesis,
  type Opportunity,
  type Signal,
  type Source,
} from '@roi-dealer/domain';
import { ConstraintViolationError, translateError } from '@roi-dealer/database';
import { uuidv7 } from '@roi-dealer/shared';
import {
  AGENT,
  createCtx,
  ctx,
  evidenceData,
  experimentData,
  hypothesisData,
  OWNER,
  opportunityData,
  painData,
  sourceData,
  SYSTEM,
} from '../../support/domain.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';

/*
 * The database is the last line of defence: these writes go around the domain and the
 * repositories (plain SQL), as a bug or a manual fix could, and must still be rejected.
 */

let test: TestDatabase;
let source: Source;
let evidence: Evidence;
let signal: Signal;
let opportunity: Opportunity;
let hypothesis: Hypothesis;
let experiment: Experiment;

beforeAll(async () => {
  test = await createTestDatabase();
  const repos = test.database.repositories;
  source = createSource(sourceData(), createCtx(sourceIdSchema, SYSTEM, 0));
  await repos.sources.insert(source);
  evidence = createEvidence(evidenceData(source.id), createCtx(evidenceIdSchema, AGENT, 1));
  await repos.evidence.insert(evidence);
  signal = createSignal(
    {
      title: 'Complaints',
      summary: 'Complaints about invoices',
      evidenceIds: [evidence.id],
      markets: ['US'],
      strength: 'weak',
    },
    createCtx(signalIdSchema, AGENT, 2),
  );
  await repos.signals.insert(signal);
  const pain = createPain(painData([evidence.id]), createCtx(painIdSchema, AGENT, 3));
  await repos.pains.insert(pain);
  opportunity = createOpportunity(
    opportunityData([pain.id]),
    createCtx(opportunityIdSchema, AGENT, 4),
  );
  await repos.opportunities.insert(opportunity);
  hypothesis = changeHypothesisStatus(
    createHypothesis(hypothesisData(opportunity.id), createCtx(hypothesisIdSchema, AGENT, 5)),
    'selected',
    ctx(OWNER, 6),
  );
  await repos.hypotheses.insert(hypothesis);
  experiment = createExperiment(
    experimentData(opportunity.id, hypothesis.id),
    hypothesis,
    createCtx(experimentIdSchema, AGENT, 7),
  );
  await repos.experiments.insert(experiment);
});

afterAll(async () => {
  await test.drop();
});

/** Runs a raw statement and returns the translated rejection. */
async function rejection(statement: () => Promise<unknown>): Promise<ConstraintViolationError> {
  try {
    await statement();
  } catch (error) {
    const translated = translateError(error);
    if (translated instanceof ConstraintViolationError) return translated;
    throw error;
  }
  throw new Error('The database accepted an invalid write');
}

const newId = (): string => uuidv7();

describe('references', () => {
  it('rejects evidence from a source that does not exist', async () => {
    const error = await rejection(
      () => test.database.sql`
        insert into evidence (id, source_id, kind, excerpt, observed_at, created_at,
                              created_by_type, created_by_id)
        values (${newId()}, ${newId()}, 'quote', 'text', now(), now(), 'agent', 'a')
      `,
    );
    expect(error).toMatchObject({ kind: 'foreign_key', constraint: 'evidence_source_id_fkey' });
  });

  it('rejects an experiment whose hypothesis belongs to another opportunity', async () => {
    const other = createOpportunity(
      opportunityData(
        (await test.database.repositories.opportunities.getById(opportunity.id))?.painIds ?? [],
      ),
      createCtx(opportunityIdSchema, AGENT, 8),
    );
    await test.database.repositories.opportunities.insert(other);

    const error = await rejection(
      () => test.database.sql`
        update experiments set opportunity_id = ${other.id}, version = version + 1
        where id = ${experiment.id}
      `,
    );
    expect(error).toMatchObject({ kind: 'foreign_key', constraint: 'experiments_hypothesis_fkey' });
  });

  it('rejects a malformed id', async () => {
    const error = await rejection(
      () => test.database.sql`select * from sources where id = ${'not-a-uuid'}::uuid`,
    );
    expect(error).toMatchObject({ kind: 'invalid_value', sqlState: '22P02' });
    expect(error.message).not.toContain('not-a-uuid');
  });
});

describe('values', () => {
  it.each([
    ['a lowercase country code', ['us'], 'sources_markets_check'],
    ['a repeated country code', ['US', 'US'], 'sources_markets_check'],
    ['no market at all', [], 'sources_markets_check'],
  ])('rejects %s', async (_case, markets, constraint) => {
    const error = await rejection(
      () => test.database.sql`
        update sources set markets = ${markets}, version = version + 1 where id = ${source.id}
      `,
    );
    expect(error).toMatchObject({ kind: 'check', constraint });
  });

  it('rejects text with surrounding spaces or over the limit', async () => {
    const padded = await rejection(
      () => test.database.sql`
        update sources set name = ${' Reddit '}, version = version + 1 where id = ${source.id}
      `,
    );
    const tooLong = await rejection(
      () => test.database.sql`
        update sources set name = ${'x'.repeat(201)}, version = version + 1 where id = ${source.id}
      `,
    );
    expect(padded).toMatchObject({ kind: 'check', constraint: 'text_200_check' });
    expect(tooLong).toMatchObject({ kind: 'check', constraint: 'text_200_check' });
  });

  it('rejects a missing required value', async () => {
    const error = await rejection(
      () => test.database.sql`
        update sources set name = null, version = version + 1 where id = ${source.id}
      `,
    );
    expect(error).toMatchObject({ kind: 'not_null', table: 'sources' });
  });

  it('rejects an unknown status', async () => {
    const error = await rejection(
      () => test.database.sql`
        update sources set status = 'deleted', version = version + 1 where id = ${source.id}
      `,
    );
    expect(error).toMatchObject({ kind: 'check', constraint: 'sources_status_check' });
  });

  it('rejects evidence observed after it was recorded', async () => {
    const error = await rejection(
      () => test.database.sql`
        insert into evidence (id, source_id, kind, excerpt, observed_at, created_at,
                              created_by_type, created_by_id)
        values (${newId()}, ${source.id}, 'quote', 'text', now() + interval '1 hour', now(),
                'agent', 'a')
      `,
    );
    expect(error).toMatchObject({
      kind: 'check',
      constraint: 'evidence_observed_not_after_created',
    });
  });
});

describe('money', () => {
  it('rejects a stop-loss above the budget', async () => {
    const error = await rejection(
      () => test.database.sql`
        update hypotheses set stop_loss_usd_cents = budget_usd_cents + 1, version = version + 1
        where id = ${hypothesis.id}
      `,
    );
    expect(error).toMatchObject({
      kind: 'check',
      constraint: 'hypotheses_stop_loss_within_budget',
    });
  });

  it('rejects a cost that is not positive', async () => {
    const error = await rejection(
      () => test.database.sql`
        insert into cost_entries (id, category, amount_usd_cents, description, incurred_at,
                                  recurring, created_at, created_by_type, created_by_id)
        values (${newId()}, 'ai', 0, 'free?', now(), false, now(), 'system', 's')
      `,
    );
    expect(error).toMatchObject({
      kind: 'check',
      constraint: 'cost_entries_amount_usd_cents_check',
    });
  });

  it('rejects amounts JavaScript cannot represent exactly', async () => {
    const error = await rejection(
      () => test.database.sql`
        update hypotheses set budget_usd_cents = 9007199254740992, version = version + 1
        where id = ${hypothesis.id}
      `,
    );
    expect(error).toMatchObject({ kind: 'check', constraint: 'usd_cents_check' });
  });
});

describe('human gates', () => {
  const approvalRow = (kind: string, amount: number | null, status: string) =>
    test.database.sql`
      insert into approval_requests (id, kind, title, summary, amount_usd_cents, expires_at, status,
                                     created_at, created_by_type, created_by_id, updated_at, version)
      values (${newId()}, ${kind}, 'Spend', 'Why', ${amount}, now() + interval '1 day', ${status},
              now(), 'system', 's', now(), 1)
    `;

  it('rejects a money approval without an amount', async () => {
    const error = await rejection(() => approvalRow('spend', null, 'pending'));
    expect(error).toMatchObject({ kind: 'check', constraint: 'approval_requests_amount_required' });
  });

  it('rejects an approved request without a recorded owner decision', async () => {
    const error = await rejection(() => approvalRow('legal', null, 'approved'));
    expect(error).toMatchObject({
      kind: 'check',
      constraint: 'approval_requests_resolution_matches_status',
    });
  });

  it('rejects a running experiment without a launch approval', async () => {
    const error = await rejection(
      () => test.database.sql`
        update experiments set status = 'running', started_at = now(), version = version + 1
        where id = ${experiment.id}
      `,
    );
    expect(error).toMatchObject({
      kind: 'check',
      constraint: 'experiments_launch_approval_referenced',
    });
  });

  it('rejects a reward for an AI agent', async () => {
    const error = await rejection(
      () => test.database.sql`
        insert into rewards (id, contributor_type, contributor_id, amount_usd_cents, rule_id, status,
                             created_at, created_by_type, created_by_id, updated_at, version)
        values (${newId()}, 'agent', 'research-agent', 100, 'manual-v1', 'calculated',
                now(), 'system', 's', now(), 1)
      `,
    );
    expect(error).toMatchObject({ kind: 'check', constraint: 'rewards_contributor_type_check' });
  });
});

describe('history protection', () => {
  it.each([
    ['update evidence', 'evidence_update_forbidden'],
    ['delete evidence', 'evidence_delete_forbidden'],
  ])('rejects an attempt to %s', async (action, constraint) => {
    const error = await rejection(() =>
      action.startsWith('update')
        ? test.database.sql`update evidence set excerpt = 'edited' where id = ${evidence.id}`
        : test.database.sql`delete from evidence where id = ${evidence.id}`,
    );
    expect(error).toMatchObject({ kind: 'forbidden_change', constraint, table: 'evidence' });
  });

  it('rejects deleting or truncating a versioned entity table', async () => {
    const deleted = await rejection(
      () => test.database.sql`delete from sources where id = ${source.id}`,
    );
    const truncated = await rejection(() => test.database.sql`truncate sources cascade`);
    expect(deleted).toMatchObject({
      kind: 'forbidden_change',
      constraint: 'sources_delete_forbidden',
    });
    expect(truncated).toMatchObject({ kind: 'forbidden_change' });
  });

  it('rejects removing a link row', async () => {
    const error = await rejection(
      () => test.database.sql`delete from signal_evidence where signal_id = ${signal.id}`,
    );
    expect(error).toMatchObject({
      kind: 'forbidden_change',
      constraint: 'signal_evidence_delete_forbidden',
    });
  });

  it('rejects an update that does not increment the version by exactly one', async () => {
    const skipped = await rejection(
      () => test.database.sql`
        update sources set trust = 'high', version = version + 2 where id = ${source.id}
      `,
    );
    const unchanged = await rejection(
      () => test.database.sql`update sources set trust = 'high' where id = ${source.id}`,
    );
    expect(skipped).toMatchObject({ kind: 'check', constraint: 'sources_version_increment' });
    expect(unchanged).toMatchObject({ kind: 'check', constraint: 'sources_version_increment' });
  });

  it('rejects rewriting who created a record and when', async () => {
    const error = await rejection(
      () => test.database.sql`
        update sources set created_by_type = 'owner', version = version + 1 where id = ${source.id}
      `,
    );
    expect(error).toMatchObject({ kind: 'check', constraint: 'sources_creation_immutable' });
  });
});
