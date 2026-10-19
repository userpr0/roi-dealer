import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { painAnalystAgent, runAgent } from '@roi-dealer/agents';
import { createAiRuntime, createAnthropicProvider, type AiRuntime } from '@roi-dealer/ai-runtime';
import { buildDigest, ensureAccessRequest, painsText } from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import {
  approvePrincipal,
  AUTOMATION_CONTROL_ID,
  createEvidence,
  createSource,
  evidenceIdSchema,
  pauseSystem,
  resumeSystem,
  sourceIdSchema,
  toTimestamp,
  type Evidence,
  type Source,
  type SystemControl,
} from '@roi-dealer/domain';
import {
  analyzeEvidence,
  extractSignalTask,
  matchPainTask,
  PAIN_ANALYST,
  SIGNAL_TASKS,
  type ExtractSignalOutput,
} from '@roi-dealer/signals';
import { uuidv7 } from '@roi-dealer/shared';
import { OWNER, SYSTEM, sourceData } from '../../support/domain.js';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { promptText, startFakeAi, type FakeAi, type FakeAiRequest } from '../../support/fake-ai.js';
import { createCapturingLogger } from '../../support/logger.js';

let test: TestDatabase;
let db: Database;
let claude: FakeAi;
let runtime: AiRuntime;
let forum: Source;
let blog: Source;
const { logger, records } = createCapturingLogger('worker');
const now = () => toTimestamp(new Date());

const NO_PAIN: ExtractSignalOutput = {
  pain: false,
  statement: '',
  audience: '',
  outcome: '',
  strength: 'weak',
  quote: '',
};
const pain = (statement: string, audience: string, quote: string): ExtractSignalOutput => ({
  pain: true,
  statement,
  audience,
  outcome: 'Solve it',
  strength: 'moderate',
  quote,
});

/** What the fake model says about texts that are not in the golden sets. */
const answers = new Map<string, ExtractSignalOutput>();
/** The fake `match-pain` answer for prompts outside the golden set. */
let matchAnswer = (_prompt: string): string => 'P1';

const GOLDEN_EXTRACT = new Map(
  extractSignalTask.evalCases.map((c) => [c.input.text, c.expected] as const),
);
const GOLDEN_MATCH = new Map(
  matchPainTask.evalCases.map((c) => [matchPainTask.render(c.input), c.expected] as const),
);

/** A model that answers the golden sets perfectly and the test texts as the test says. */
function oracle(request: FakeAiRequest) {
  if (request.instructions === extractSignalTask.instructions) {
    const text = promptText(request.prompt);
    const golden = GOLDEN_EXTRACT.get(text);
    const output =
      golden === undefined
        ? (answers.get(text) ?? NO_PAIN)
        : golden.pain
          ? pain('Someone struggles with a costly problem here', 'Someone', text.slice(0, 40))
          : NO_PAIN;
    return { text: JSON.stringify(output) };
  }
  if (request.instructions === matchPainTask.instructions) {
    const match = GOLDEN_MATCH.get(request.prompt) ?? matchAnswer(request.prompt);
    return { text: JSON.stringify({ match }) };
  }
  return { status: 400 };
}

const calls = (instructions: string) =>
  claude.calls.filter((call) => call.instructions === instructions).length;

async function addEvidence(source: Source, text: string): Promise<Evidence> {
  const evidence = createEvidence(
    { sourceId: source.id, kind: 'post', excerpt: text, observedAt: now() },
    { id: evidenceIdSchema.parse(uuidv7()), actor: SYSTEM, at: now() },
  );
  await db.repositories.evidence.insert(evidence);
  return evidence;
}

async function extraction(evidence: Evidence) {
  const [row] = await db.sql<
    { outcome: string; signal_id: string | null; pain_id: string | null }[]
  >`
    select outcome, signal_id, pain_id from signal_extractions where evidence_id = ${evidence.id}
  `;
  return row;
}

async function setKillSwitch(paused: boolean): Promise<void> {
  const control = (await db.repositories.systemControls.getById(
    AUTOMATION_CONTROL_ID,
  )) as SystemControl;
  const next = paused
    ? pauseSystem(control, 'Тест стоп-крана', { actor: OWNER, at: now() })
    : resumeSystem(control, { actor: OWNER, at: now() });
  await db.repositories.systemControls.update(next, OWNER);
}

const deps = () => ({ database: db, logger, runtime });

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  claude = await startFakeAi('anthropic');
  claude.answer(oracle);
  runtime = createAiRuntime({
    database: db,
    logger,
    providers: [
      createAnthropicProvider({ apiKey: 'sk-ant-signals-test', baseUrl: claude.baseUrl }),
    ],
    timeoutMs: 5_000,
  });
  forum = createSource(sourceData({ name: 'Test forum', markets: ['US', 'GB'] }), {
    id: sourceIdSchema.parse(uuidv7()),
    actor: SYSTEM,
    at: now(),
  });
  blog = createSource(sourceData({ name: 'Test blog', markets: ['CA'] }), {
    id: sourceIdSchema.parse(uuidv7()),
    actor: SYSTEM,
    at: now(),
  });
  await db.repositories.sources.insert(forum);
  await db.repositories.sources.insert(blog);
});

afterAll(async () => {
  await claude.close();
  await test.drop();
});

beforeEach(() => {
  claude.answer(oracle);
  matchAnswer = () => 'P1';
});

describe('the pain analyst needs the owner’s grant (PHASE 04)', () => {
  it('asks in /decisions and calls no model before the grant', async () => {
    await addEvidence(forum, 'Ask HN: anything to analyze?');
    await expect(analyzeEvidence(deps())).resolves.toEqual({
      status: 'skipped',
      reason: 'access_missing',
    });

    await expect(
      runAgent(painAnalystAgent(), {
        ...deps(),
        ensureAccess: ensureAccessRequest,
        now: Date.now,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe('no_access');
    const [request] = (await db.repositories.approvalRequests.listByStatus('pending')).filter(
      (item) => item.kind === 'access_grant',
    );
    expect(request?.title).toBe('Доступ: Агент болей и сигналов');
    expect(request?.summary).toContain('Только предлагает');
    expect(records).toContainEqual(
      expect.objectContaining({
        message: 'agent run',
        agent: 'pain-analyst',
        outcome: 'no_access',
      }),
    );
    expect(claude.calls).toEqual([]);

    const principal = await db.repositories.principals.getByActor(PAIN_ANALYST);
    if (principal === undefined) throw new Error('no principal');
    await db.repositories.principals.update(
      approvePrincipal(principal, { actor: OWNER, at: now() }),
      OWNER,
    );
  });

  it('runs both tasks only after their evals passed', async () => {
    const reports = await runtime.evaluateMissing(SIGNAL_TASKS);
    expect(reports.map((report) => [report.task, report.score.passed])).toEqual([
      ['extract-signal', true],
      ['match-pain', true],
    ]);
  });
});

describe('from evidence to pain candidates (PHASE 06)', () => {
  it('creates signals with quotes, groups similar ones and records every evidence once', async () => {
    // The evidence of the first test was never analyzed: the model sees no pain in it.
    const late = await addEvidence(
      forum,
      'Ask HN: How do you chase late invoices? Our clients pay 60 days late and I spend Fridays sending reminders.',
    );
    const launch = await addEvidence(
      forum,
      'Show HN: My weekend project, a Rust static site generator',
    );
    const agency = await addEvidence(
      forum,
      'Late payments are killing my small agency: clients pay invoices after 90 days and I chase them every week.',
    );
    const invented = await addEvidence(
      forum,
      'Our dental clinic loses money because patients skip appointments.',
    );
    const stock = await addEvidence(
      forum,
      'We run an online store and inventory never syncs between Shopify and Amazon, so we oversell.',
    );
    answers.set(
      late.excerpt,
      pain(
        'Freelancers struggle to get clients to pay invoices on time',
        'Freelancers',
        'Our clients pay 60 days late',
      ),
    );
    answers.set(
      agency.excerpt,
      pain(
        'Freelancers and agencies struggle to get clients to pay invoices on time',
        'Small agencies',
        'clients pay invoices after 90 days',
      ),
    );
    answers.set(
      invented.excerpt,
      pain('Clinics lose money on missed appointments', 'Dental clinics', 'patients never show up'),
    );
    answers.set(
      stock.excerpt,
      pain(
        'Online sellers oversell because inventory does not sync between marketplaces',
        'Online sellers',
        'inventory never syncs between Shopify and Amazon',
      ),
    );
    const matches = calls(matchPainTask.instructions);

    const outcome = await analyzeEvidence(deps());
    expect(outcome).toEqual({
      status: 'analyzed',
      analyzed: 6,
      signals: 3,
      newPains: 2,
      validated: 0,
      stoppedBy: undefined,
    });
    // Only the second invoice signal had a similar pain to compare with.
    expect(calls(matchPainTask.instructions)).toBe(matches + 1);

    expect(await extraction(launch)).toMatchObject({ outcome: 'no_pain', signal_id: null });
    expect(await extraction(invented)).toMatchObject({ outcome: 'rejected', signal_id: null });
    const first = await extraction(late);
    const second = await extraction(agency);
    expect(first?.outcome).toBe('signal');
    expect(second?.pain_id).toBe(first?.pain_id);
    expect((await extraction(stock))?.pain_id).not.toBe(first?.pain_id);

    const [invoices] = await db.repositories.pains.listByStatus('candidate');
    expect(invoices).toMatchObject({
      title: 'Freelancers struggle to get clients to pay invoices on time',
      audience: 'Freelancers',
      severity: 3,
      frequency: 'occasional',
      markets: ['US', 'GB'],
      evidenceIds: [late.id, agency.id],
      createdBy: PAIN_ANALYST,
    });
    const signal = await db.repositories.signals.getById(invoices?.signalIds[1] as never);
    expect(signal).toMatchObject({
      status: 'triaged',
      evidenceIds: [agency.id],
      strength: 'moderate',
      createdBy: PAIN_ANALYST,
    });
    expect(signal?.summary).toContain('Quote: "clients pay invoices after 90 days"');

    // Everything is analyzed: the next run spends nothing.
    const before = claude.calls.length;
    await expect(analyzeEvidence(deps())).resolves.toEqual({
      status: 'skipped',
      reason: 'nothing_new',
    });
    expect(claude.calls).toHaveLength(before);
  });

  it('validates a pain once its evidence comes from two sources', async () => {
    const other = await addEvidence(
      blog,
      'Clients pay our invoices months late and freelancers like me cannot plan anything.',
    );
    answers.set(
      other.excerpt,
      pain(
        'Freelancers struggle to get clients to pay invoices on time',
        'Freelancers',
        'Clients pay our invoices months late',
      ),
    );
    await expect(analyzeEvidence(deps())).resolves.toMatchObject({
      signals: 1,
      newPains: 0,
      validated: 1,
    });
    const [validated] = await db.repositories.pains.listByStatus('validated');
    expect(validated?.markets).toEqual(['US', 'GB', 'CA']);
    expect(validated?.signalIds).toHaveLength(3);
  });

  it('starts a new pain when the model names a key outside the list', async () => {
    const evidence = await addEvidence(
      forum,
      'Freelancers here: clients keep paying invoices late and we lose sleep over cash flow.',
    );
    answers.set(
      evidence.excerpt,
      pain(
        'Freelancers lose sleep because clients pay invoices late',
        'Freelancers',
        'clients keep paying invoices late',
      ),
    );
    matchAnswer = () => 'P7';
    await expect(analyzeEvidence(deps())).resolves.toMatchObject({ signals: 1, newPains: 1 });
  });
});

describe('stops without wasting budget', () => {
  it('the kill switch stops the run before any call', async () => {
    await addEvidence(forum, 'Ask HN: waiting while the system is paused.');
    const before = claude.calls.length;
    await setKillSwitch(true);
    try {
      await expect(analyzeEvidence(deps())).rejects.toMatchObject({ code: 'automation_paused' });
    } finally {
      await setKillSwitch(false);
    }
    expect(claude.calls).toHaveLength(before);
  });

  it('no usable model stops the run and keeps the evidence for later', async () => {
    const offline = createAiRuntime({ database: db, logger, providers: [] });
    const [pending] = await db.signalExtractions.pending({ limit: 1 });
    await expect(
      analyzeEvidence({ database: db, logger, runtime: offline }),
    ).resolves.toMatchObject({ analyzed: 0, stoppedBy: 'unavailable' });
    expect(await extraction(pending as Evidence)).toBeUndefined();
  });

  it('a failure of every model is recorded once, so the queue moves on', async () => {
    await addEvidence(forum, 'Ask HN: the model fails on this one.');
    await addEvidence(forum, 'Ask HN: and this one waits.');
    const queue = await db.signalExtractions.pending({ limit: 10 });
    expect(queue.length).toBeGreaterThanOrEqual(2);
    claude.answer(() => ({ status: 500 }));
    await expect(analyzeEvidence(deps())).resolves.toMatchObject({
      analyzed: 1,
      stoppedBy: 'failed',
    });
    const [head, ...rest] = queue;
    expect(await extraction(head as Evidence)).toMatchObject({
      outcome: 'failed',
      signal_id: null,
    });
    for (const evidence of rest) expect(await extraction(evidence)).toBeUndefined();
  });
});

describe('the owner sees what was found', () => {
  it('/pains lists open pains with signals, sources and status; the digest counts them', async () => {
    const text = await painsText(db.repositories);
    expect(text).toMatch(/^🧩 Боли · открытых: 3/);
    expect(text).toContain('1. Freelancers struggle to get clients to pay invoices on time');
    expect(text).toContain('Сигналов 3 · источников 2 · ✅ подтверждена · иногда · тяжесть 3/5');
    expect(text).toContain('Кто: Online sellers');

    const digest = await buildDigest(db, Date.now());
    expect(digest).toContain('🧩 За сутки: сигналов 5, новых болей 3 → /pains');
  });

  it('keeps the texts of the posts out of the logs', () => {
    const logs = JSON.stringify(records);
    for (const secret of ['60 days late', 'Shopify and Amazon', 'months late']) {
      expect(logs).not.toContain(secret);
    }
  });
});
