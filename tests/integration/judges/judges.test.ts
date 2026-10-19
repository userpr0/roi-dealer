import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAgent } from '@roi-dealer/agents';
import { createAiRuntime, createAnthropicProvider, type AiRuntime } from '@roi-dealer/ai-runtime';
import { ensureAccessRequest, opportunitiesText } from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import {
  approvePrincipal,
  AUTOMATION_CONTROL_ID,
  createEvidence,
  createOpportunity,
  createPain,
  createSignal,
  createSource,
  evidenceIdSchema,
  JUDGE_CRITERIA,
  opportunityIdSchema,
  painIdSchema,
  pauseSystem,
  resumeSystem,
  signalIdSchema,
  sourceIdSchema,
  toTimestamp,
  type Evidence,
  type JudgeCriterion,
  type Opportunity,
  type Source,
  type SystemControl,
} from '@roi-dealer/domain';
import {
  CRITERION_SCALES,
  JUDGE_TASKS,
  JUDGES,
  judgesAgent,
  judgeOpportunityTask,
  type JudgeOutput,
} from '@roi-dealer/judges';
import { uuidv7 } from '@roi-dealer/shared';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { OWNER, SYSTEM, sourceData } from '../../support/domain.js';
import { startFakeAi, type FakeAi, type FakeAiRequest } from '../../support/fake-ai.js';
import { judgeGolden, perfectJudgeAnswer } from '../../support/judge-answers.js';
import { createCapturingLogger } from '../../support/logger.js';

let test: TestDatabase;
let db: Database;
let claude: FakeAi;
let runtime: AiRuntime;
let forum: Source;
const { logger, records } = createCapturingLogger('worker');
const now = () => toTimestamp(new Date());
const golden = judgeGolden();

const criterionOf = (prompt: string): JudgeCriterion | undefined =>
  JUDGE_CRITERIA.find((criterion) => prompt.includes(CRITERION_SCALES[criterion]));

/** What the fake judges say about opportunities outside the golden set, by criterion. */
let verdicts: Partial<Record<JudgeCriterion, JudgeOutput | 'down'>> = {};
const verdict = (score: number, evidence: number[] = [1]): JudgeOutput => ({
  score,
  rationale: 'The posts show agencies paying people to do this by hand every week.',
  evidence,
  concerns: ['Only one community so far.'],
});

function oracle(request: FakeAiRequest) {
  if (request.instructions !== judgeOpportunityTask.instructions) return { status: 400 };
  const expected = golden.get(request.prompt);
  if (expected !== undefined) return { text: JSON.stringify(perfectJudgeAnswer(expected)) };
  const criterion = criterionOf(request.prompt);
  const answer = criterion === undefined ? undefined : verdicts[criterion];
  if (answer === 'down') return { status: 529 };
  return { text: JSON.stringify(answer ?? verdict(3)) };
}

const run = () =>
  runAgent(judgesAgent({ marketWaitMs: 3_600_000 }), {
    database: db,
    logger,
    runtime,
    ensureAccess: ensureAccessRequest,
    now: Date.now,
    signal: new AbortController().signal,
  });

async function evidenceOf(text: string): Promise<Evidence> {
  const evidence = createEvidence(
    { sourceId: forum.id, kind: 'post', excerpt: text, observedAt: now() },
    { id: evidenceIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.evidence.insert(evidence);
  return evidence;
}

async function opportunityWith(texts: readonly string[], title: string): Promise<Opportunity> {
  const evidence: Evidence[] = [];
  for (const text of texts) evidence.push(await evidenceOf(text));
  const signal = createSignal(
    {
      title,
      summary: title,
      evidenceIds: evidence.map((item) => item.id),
      markets: ['US'],
      strength: 'moderate',
    },
    { id: signalIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.signals.insert(signal);
  const pain = createPain(
    {
      title,
      description: title,
      audience: 'Small agencies',
      desiredOutcome: 'Books that match payouts',
      severity: 3,
      frequency: 'rare',
      markets: ['US'],
      signalIds: [signal.id],
      evidenceIds: evidence.map((item) => item.id),
    },
    { id: painIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.pains.insert(pain);
  const opportunity = createOpportunity(
    {
      title,
      summary: `${title}. Agencies lose hours every week.`,
      painIds: [pain.id],
      icp: 'Agencies with 2–20 people',
      markets: ['US'],
      valueProposition: {
        problem: 'Payouts do not match the books',
        change: 'Matched automatically',
        measurableResult: 'Six hours a week saved',
      },
      businessModel: { model: 'subscription', pricingHypothesis: '$49 a month' },
    },
    { id: opportunityIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.opportunities.insert(opportunity);
  return opportunity;
}

/** The market context agent has worked on this version (PHASE 10). */
async function marketDone(opportunity: Opportunity): Promise<void> {
  await db.agentWork.record({
    agent: 'market-analyst',
    subjectType: 'opportunity',
    subjectId: opportunity.id,
    subjectVersion: opportunity.version,
    task: 'market-context',
    taskVersion: 1,
    outcome: 'empty',
    actorType: 'agent',
    actorId: 'market-analyst',
  });
}

const rows = (opportunity: Opportunity) =>
  db.sql<
    {
      criterion: string;
      outcome: string;
      score: number | null;
      supported: boolean | null;
      evidence_ids: string[];
      opportunity_version: number;
    }[]
  >`
    select criterion, outcome, score, supported, evidence_ids, opportunity_version
    from opportunity_judgements where opportunity_id = ${opportunity.id} order by id
  `;

async function setKillSwitch(paused: boolean): Promise<void> {
  const control = (await db.repositories.systemControls.getById(
    AUTOMATION_CONTROL_ID,
  )) as SystemControl;
  const next = paused
    ? pauseSystem(control, 'Тест стоп-крана', { actor: OWNER, at: now() })
    : resumeSystem(control, { actor: OWNER, at: now() });
  await db.repositories.systemControls.update(next, OWNER);
}

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  claude = await startFakeAi('anthropic');
  runtime = createAiRuntime({
    database: db,
    logger,
    providers: [createAnthropicProvider({ apiKey: 'sk-ant-judges-test', baseUrl: claude.baseUrl })],
    timeoutMs: 5_000,
  });
  forum = createSource(sourceData({ name: 'Test forum' }), {
    id: sourceIdSchema.parse(uuidv7()),
    actor: SYSTEM,
    at: now(),
  });
  await db.repositories.sources.insert(forum);
});

afterAll(async () => {
  await claude.close();
  await test.drop();
});

beforeEach(() => {
  claude.answer(oracle);
  verdicts = {};
});

describe('the judges need the owner’s grant and a passing eval (PHASE 11)', () => {
  it('stop on the kill switch and ask for access before any call', async () => {
    await setKillSwitch(true);
    await expect(run()).resolves.toBe('paused');
    await setKillSwitch(false);
    await expect(run()).resolves.toBe('no_access');
    const [request] = (await db.repositories.approvalRequests.listByStatus('pending')).filter(
      (item) => item.kind === 'access_grant',
    );
    expect(request?.title).toBe('Доступ: Судьи');
    expect(claude.calls).toEqual([]);
    const principal = await db.repositories.principals.getByActor(JUDGES);
    if (principal === undefined) throw new Error('no principal');
    await db.repositories.principals.update(
      approvePrincipal(principal, { actor: OWNER, at: now() }),
      OWNER,
    );
  });

  it('run the judge task on the strong model only after its eval passed', async () => {
    const reports = await runtime.evaluateMissing(JUDGE_TASKS);
    expect(reports.map((report) => [report.task, report.model, report.score.passed])).toEqual([
      ['judge-opportunity', 'claude-opus-5-5', true],
    ]);
  });
});

describe('six independent judgements per opportunity version', () => {
  let opportunity: Opportunity;

  it('wait for the market context of the version', async () => {
    opportunity = await opportunityWith(
      [
        'Reconciling Stripe payouts takes our accountant 6 hours a week.',
        'We pay a bookkeeper $400 a month mostly to match payouts by hand.',
      ],
      'Automatic payout reconciliation for agencies',
    );
    const calls = claude.calls.length;
    await expect(run()).resolves.toBe('idle');
    expect(claude.calls).toHaveLength(calls);
  });

  it('judge every criterion in its own call, check it and submit the opportunity', async () => {
    await marketDone(opportunity);
    verdicts = {
      market: verdict(4, [2]),
      // No citation: an evidence-bound score is capped at 2.
      pain_value: verdict(5, []),
      // Only a citation that does not exist.
      economics: verdict(5, [7]),
      buildability: verdict(4, []),
      risk: { ...verdict(4), rationale: 'Fine.' },
      reuse: verdict(3),
    };
    const calls = claude.calls.length;
    await expect(run()).resolves.toBe('done');
    const judgeCalls = claude.calls.slice(calls);
    expect(judgeCalls).toHaveLength(6);
    expect(judgeCalls.map((call) => criterionOf(call.prompt))).toEqual([...JUDGE_CRITERIA]);
    // Newest evidence first.
    expect(judgeCalls[0]?.prompt).toContain('E1. """We pay a bookkeeper $400 a month');

    const judged = await rows(opportunity);
    expect(judged.map((row) => [row.criterion, row.outcome, row.score, row.supported])).toEqual([
      ['market', 'judged', 4, true],
      ['pain_value', 'judged', 2, false],
      ['economics', 'judged', 2, false],
      ['buildability', 'judged', 4, false],
      ['risk', 'rejected', null, null],
      ['reuse', 'judged', 3, true],
    ]);
    expect(judged[0]?.evidence_ids).toHaveLength(1);

    const submitted = await db.repositories.opportunities.getById(opportunity.id);
    expect(submitted).toMatchObject({ status: 'under_review', version: opportunity.version + 1 });
    const history = await db.events.history({ type: 'opportunity', id: opportunity.id });
    expect(history.at(-1)).toMatchObject({ actor: JUDGES });
    // The new version is the owner's turn: the judges do not judge it again.
    await expect(run()).resolves.toBe('idle');

    const text = await opportunitiesText(db.repositories, db.opportunityAssessments, db.judgements);
    expect(text).toContain(
      '   ⚖️ Судьи: оценивают · рынок 4 · боль 2 · экономика 2 · сборка 4 · риск — · повтор 3',
    );
    expect(text).toContain('Слабые места: боль, экономика');
    expect(text).toContain('ждёт решения');
  });

  it('continue with the remaining criteria after a run stopped early', async () => {
    const other = await opportunityWith(
      ['Our front desk calls every patient the day before, two hours a day.'],
      'Fewer no-shows for small clinics',
    );
    await marketDone(other);
    verdicts = { economics: 'down' };
    await expect(run()).resolves.toBe('stopped');
    expect((await rows(other)).map((row) => [row.criterion, row.outcome])).toEqual([
      ['market', 'judged'],
      ['pain_value', 'judged'],
      ['economics', 'failed'],
    ]);
    expect((await db.agentRuns.latest()).get('judges')).toMatchObject({
      outcome: 'stopped',
      stoppedBy: 'failed',
    });
    expect((await db.repositories.opportunities.getById(other.id))?.status).toBe('draft');

    verdicts = {};
    const calls = claude.calls.length;
    await expect(run()).resolves.toBe('done');
    expect(claude.calls.slice(calls).map((call) => criterionOf(call.prompt))).toEqual([
      'buildability',
      'risk',
      'reuse',
    ]);
    expect(await rows(other)).toHaveLength(6);
    expect((await db.repositories.opportunities.getById(other.id))?.status).toBe('under_review');
  });

  it('do not wait forever for a market context', async () => {
    const waiting = await opportunityWith(
      ['We lose decisions in Slack threads every week.'],
      'Decisions that are easy to find later',
    );
    const agent = judgesAgent({ marketWaitMs: 0 });
    await expect(
      runAgent(agent, {
        database: db,
        logger,
        runtime,
        ensureAccess: ensureAccessRequest,
        now: Date.now,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe('done');
    expect(await rows(waiting)).toHaveLength(6);
    expect(JSON.stringify(records)).not.toContain('bookkeeper $400');
  });
});
