import { z } from 'zod';
import {
  AI_BUDGET_LIMITS,
  assertAutomationRunning,
  AUTOMATION_CONTROL_ID,
  createKnowledgeAsset,
  dailyAiAllowanceMicroUsd,
  knowledgeAssetIdSchema,
  MICRO_USD_PER_USD,
  startOfUtcDay,
  startOfUtcMonth,
  toTimestamp,
  type Actor,
  type AiBudgetLimits,
  type Timestamp,
} from '@roi-dealer/domain';
import type { AiCallPurpose, AiFailure, Database } from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';
import { uuidv7 } from '@roi-dealer/shared';
import { callCostMicroUsd, MODEL_REGISTRY, modelTag, type ModelSpec } from './models.js';
import { classifyError, ProviderFailure, type AiProviderClient } from './providers/provider.js';
import { EVAL_DAILY_SHARE, type AiTask, type AnyAiTask, type EvalScore } from './task.js';

const USD = MICRO_USD_PER_USD;

/** The platform's own actor for evals and the daily cost entry. */
export const AI_RUNTIME_ACTOR: Actor = { type: 'system', id: 'ai-runtime' };

export type AiTaskErrorCode =
  /** No model may run the task: no key, no passing eval, or the provider does not list it. */
  | 'unavailable'
  /** The month, today's allowance or the task's share of it would be exceeded: no call. */
  | 'budget'
  /** The input does not match the task's schema. */
  | 'invalid_input'
  /** Every allowed model failed. */
  | 'failed';

export interface Attempt {
  readonly model: string;
  readonly outcome: 'ok' | 'failed';
  readonly failure?: AiFailure | undefined;
}

/** Carries a stable code and the attempts; never prompts, outputs or keys. */
export class AiTaskError extends Error {
  override readonly name = 'AiTaskError';
  readonly code: AiTaskErrorCode;
  readonly task: string;
  readonly attempts: readonly Attempt[];

  constructor(code: AiTaskErrorCode, task: string, attempts: readonly Attempt[] = []) {
    super(`AI task ${task}: ${code}`);
    this.code = code;
    this.task = task;
    this.attempts = attempts;
  }
}

export interface TaskContext {
  /** Who the task runs for; recorded with every call. */
  readonly actor: Actor;
  readonly correlationId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface EvalReport {
  readonly task: string;
  readonly version: number;
  readonly model: string;
  readonly score: EvalScore;
  readonly cases: number;
  readonly costMicroUsd: number;
}

/** Spend of the current UTC month and day and today's allowance, in micro-USD. */
export interface AiSpendToday {
  readonly month: number;
  readonly day: number;
  readonly allowance: number;
}

export interface AiRuntimeOptions {
  readonly database: Database;
  readonly logger: Logger;
  /** Providers with a key; none — every task is `unavailable`. */
  readonly providers: readonly AiProviderClient[];
  /** Default: `MODEL_REGISTRY`. */
  readonly models?: readonly ModelSpec[];
  /** Default: `AI_BUDGET_LIMITS` (D-007). */
  readonly limits?: AiBudgetLimits;
  readonly now?: () => number;
  /** Per call. Default: 60 s. */
  readonly timeoutMs?: number;
}

export interface AiRuntime {
  /**
   * Runs a task (§2.3: the result is a proposal the caller checks and applies):
   * input schema → kill switch → allowed models in routing order (key, model list, passing
   * eval) → budget before every attempt → call → output schema → `ai_calls`. On a failure the
   * next model — of another provider first — is tried.
   */
  runTask<Input, Output, Expected>(
    task: AiTask<Input, Output, Expected>,
    input: Input,
    context: TaskContext,
  ): Promise<Output>;
  /** Asks each provider for its models; ids it does not list are not used. */
  verifyModels(): Promise<Readonly<Record<string, boolean>>>;
  /** Runs the golden set of a task on a model and stores the report as a KnowledgeAsset. */
  evaluate(task: AnyAiTask, modelId: string): Promise<EvalReport>;
  /** Evaluates every usable model of the tasks that has no report for the task version yet. */
  evaluateMissing(tasks: readonly AnyAiTask[]): Promise<EvalReport[]>;
  /** The models a task would use now, in routing order. */
  route(task: AnyAiTask): Promise<string[]>;
  spend(): Promise<AiSpendToday>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DAY_MS = 24 * 3_600_000;
const ROUTE_CACHE_MS = 5 * 60_000;

const iso = (ms: number): Timestamp => toTimestamp(new Date(ms));

function evalTags(task: AnyAiTask, modelId: string): string[] {
  return ['eval', `task-${task.name}`, `v-${String(task.version)}`, modelTag(modelId)];
}

/** What routing reads from a stored eval report. */
const reportBodySchema = z.object({
  costMicroUsd: z.number().nonnegative(),
  metrics: z.record(z.string(), z.number()),
});

/** What routing reads from the latest eval report of a model. */
export interface EvalSummary {
  readonly passed: boolean;
  /** Cost of the whole golden set: the same cases for every model, so it compares prices. */
  readonly costMicroUsd: number;
  /** Mean of the metrics, in [0, 1]. */
  readonly quality: number;
}

function readReport(tags: readonly string[], body: string | undefined): EvalSummary {
  let parsed: z.infer<typeof reportBodySchema> | undefined;
  try {
    const result = reportBodySchema.safeParse(JSON.parse(body ?? ''));
    parsed = result.success ? result.data : undefined;
  } catch {
    parsed = undefined;
  }
  const metrics = Object.values(parsed?.metrics ?? {});
  return {
    passed: tags.includes('passed'),
    costMicroUsd: parsed?.costMicroUsd ?? Number.MAX_SAFE_INTEGER,
    quality:
      metrics.length === 0 ? 0 : metrics.reduce((sum, value) => sum + value, 0) / metrics.length,
  };
}

/**
 * Routing order (D-021): each model does what it does best for the task, as its eval shows.
 * `bulk` — the cheapest passing model first (volume); `strong` — the best one (judgement).
 * The second place goes to another provider, so an outage costs one attempt; ties keep the
 * registry order.
 */
export function routingOrder(
  tier: AnyAiTask['tier'],
  passing: readonly { readonly model: ModelSpec; readonly report: EvalSummary }[],
): ModelSpec[] {
  const ranked = [...passing].sort((a, b) =>
    tier === 'bulk'
      ? a.report.costMicroUsd - b.report.costMicroUsd || b.report.quality - a.report.quality
      : b.report.quality - a.report.quality || a.report.costMicroUsd - b.report.costMicroUsd,
  );
  const [first, ...rest] = ranked.map((item) => item.model);
  if (first === undefined) return [];
  const other = rest.findIndex((model) => model.provider !== first.provider);
  if (other <= 0) return [first, ...rest];
  return [
    first,
    ...rest.slice(other, other + 1),
    ...rest.slice(0, other),
    ...rest.slice(other + 1),
  ];
}

export function createAiRuntime(options: AiRuntimeOptions): AiRuntime {
  const { database, logger } = options;
  const models = options.models ?? MODEL_REGISTRY;
  const limits = options.limits ?? AI_BUDGET_LIMITS;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const available = new Map<string, boolean>();
  const routes = new Map<string, { readonly models: readonly ModelSpec[]; readonly at: number }>();

  const providerOf = (model: ModelSpec) =>
    options.providers.find((provider) => provider.provider === model.provider);

  /** Models of the task's tier that have a key and are not known to be missing. */
  function usableModels(task: AnyAiTask): ModelSpec[] {
    return models.filter(
      (model) =>
        model.tier === task.tier &&
        model.structuredOutput &&
        providerOf(model) !== undefined &&
        available.get(model.id) !== false,
    );
  }

  async function reportOf(task: AnyAiTask, modelId: string): Promise<EvalSummary | undefined> {
    const [latest] = await database.repositories.knowledgeAssets.listByTags(
      evalTags(task, modelId),
      { limit: 1 },
    );
    return latest === undefined ? undefined : readReport(latest.tags, latest.body);
  }

  async function route(task: AnyAiTask): Promise<readonly ModelSpec[]> {
    const key = `${task.name}@${String(task.version)}`;
    const cached = routes.get(key);
    if (cached !== undefined && now() - cached.at < ROUTE_CACHE_MS) return cached.models;
    const passing: { model: ModelSpec; report: EvalSummary }[] = [];
    for (const model of usableModels(task)) {
      const report = await reportOf(task, model.id);
      if (report?.passed === true) passing.push({ model, report });
    }
    const ordered = routingOrder(task.tier, passing);
    routes.set(key, { models: ordered, at: now() });
    return ordered;
  }

  async function assertRunning(): Promise<void> {
    const control = await database.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
    if (control === undefined)
      throw new Error('the automation kill switch is missing (migration 0003)');
    assertAutomationRunning(control);
  }

  async function spend(): Promise<AiSpendToday> {
    const current = now();
    const dayStart = startOfUtcDay(current);
    const [beforeToday, today] = await Promise.all([
      database.aiCalls.spend({ from: iso(startOfUtcMonth(current)), to: iso(dayStart) }),
      database.aiCalls.spend({ from: iso(dayStart), to: iso(dayStart + DAY_MS) }),
    ]);
    return {
      month: beforeToday.costMicroUsd + today.costMicroUsd,
      day: today.costMicroUsd,
      allowance: dailyAiAllowanceMicroUsd(limits, beforeToday.costMicroUsd, current),
    };
  }

  /**
   * Before every attempt (D-007, D-021): the month, today's allowance and the share of it this
   * task — or evals as a whole — may use, each with the call's reserve.
   */
  async function withinBudget(task: AnyAiTask, purpose: AiCallPurpose): Promise<boolean> {
    const reserve = task.maxCostMicroUsd;
    const spent = await spend();
    if (spent.month + reserve > limits.monthlyMicroUsd) return false;
    if (spent.day + reserve > spent.allowance) return false;
    const share = purpose === 'eval' ? EVAL_DAILY_SHARE : task.dailyShare;
    const dayStart = startOfUtcDay(now());
    const used = await database.aiCalls.spend({
      from: iso(dayStart),
      to: iso(dayStart + DAY_MS),
      purpose,
      task: purpose === 'eval' ? undefined : task.name,
    });
    return used.costMicroUsd + reserve <= Math.floor(spent.allowance * share);
  }

  /** One call of one model; every attempt is recorded, successful or not. */
  async function attempt<Input, Output, Expected>(
    task: AiTask<Input, Output, Expected>,
    model: ModelSpec,
    input: Input,
    purpose: AiCallPurpose,
    context: TaskContext,
    /** Adds the cost of the attempt, for the eval report. */
    tally?: { micro: number },
  ): Promise<Output> {
    const provider = providerOf(model);
    if (provider === undefined) throw new ProviderFailure('auth');
    const started = now();
    const record = async (
      outcome: 'ok' | 'failed',
      usage: { inputTokens: number; outputTokens: number },
      failure?: AiFailure,
    ) => {
      const costMicroUsd = callCostMicroUsd(model, usage.inputTokens, usage.outputTokens);
      if (tally !== undefined) tally.micro += costMicroUsd;
      await database.aiCalls.record({
        task: task.name,
        taskVersion: task.version,
        purpose,
        provider: model.provider,
        model: model.id,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicroUsd,
        latencyMs: Math.max(0, now() - started),
        outcome,
        failure,
        actorType: context.actor.type,
        actorId: context.actor.id,
        correlationId: context.correlationId,
      });
    };
    try {
      const completion = await provider.complete({
        model: model.id,
        instructions: task.instructions,
        prompt: task.render(input),
        output: task.output,
        outputName: task.name.replaceAll('-', '_'),
        maxOutputTokens: task.maxOutputTokens,
        effort: task.tier === 'bulk' ? 'low' : 'high',
        timeoutMs,
        signal: context.signal,
      });
      await record('ok', completion);
      return completion.output;
    } catch (error) {
      const failure =
        error instanceof ProviderFailure ? error : new ProviderFailure('server_error');
      await record('failed', failure, failure.failure);
      throw failure;
    }
  }

  async function evaluate(task: AnyAiTask, modelId: string): Promise<EvalReport> {
    const model = models.find((item) => item.id === modelId);
    if (model === undefined || providerOf(model) === undefined) {
      throw new AiTaskError('unavailable', task.name);
    }
    await assertRunning();
    const context: TaskContext = {
      actor: AI_RUNTIME_ACTOR,
      correlationId: `ai-eval-${task.name}-v${String(task.version)}`,
    };
    const tally = { micro: 0 };
    const results: { expected: unknown; output: unknown }[] = [];
    for (const testCase of task.evalCases) {
      if (!(await withinBudget(task, 'eval'))) {
        throw new AiTaskError('budget', task.name);
      }
      try {
        const output: unknown = await attempt(task, model, testCase.input, 'eval', context, tally);
        results.push({ expected: testCase.expected, output });
      } catch (error) {
        const failure = error instanceof ProviderFailure ? error.failure : 'server_error';
        // The model cannot be used at all: no report, the model stays out of routing.
        if (failure === 'auth' || failure === 'model_unavailable' || failure === 'bad_request') {
          throw new AiTaskError('unavailable', task.name, [
            { model: model.id, outcome: 'failed', failure },
          ]);
        }
        results.push({ expected: testCase.expected, output: undefined });
      }
    }
    const score = task.score(results);
    const costMicroUsd = tally.micro;
    const at = iso(now());
    const metrics = Object.entries(score.metrics)
      .map(([name, value]) => `${name} ${value.toFixed(2)}`)
      .join(', ');
    await database.repositories.knowledgeAssets.insert(
      createKnowledgeAsset(
        {
          kind: 'knowledge',
          title: `Eval ${task.name} v${String(task.version)} · ${model.id}: ${score.passed ? 'пройден' : 'не пройден'}`,
          summary:
            `Эталонный прогон задачи ${task.name} v${String(task.version)} на ${model.id}: ` +
            `${metrics}; примеров ${String(task.evalCases.length)}; ` +
            `стоимость $${(costMicroUsd / USD).toFixed(4)}.`,
          body: JSON.stringify({
            task: task.name,
            version: task.version,
            model: model.id,
            provider: model.provider,
            cases: task.evalCases.length,
            metrics: score.metrics,
            passed: score.passed,
            costMicroUsd,
          }),
          links: { evidenceIds: [] },
          tags: [...evalTags(task, model.id), score.passed ? 'passed' : 'failed'],
        },
        { id: knowledgeAssetIdSchema.parse(uuidv7()), actor: AI_RUNTIME_ACTOR, at },
      ),
    );
    routes.delete(`${task.name}@${String(task.version)}`);
    logger.info(score.passed ? 'ai eval passed' : 'ai eval failed', {
      task: task.name,
      version: task.version,
      model: model.id,
      metrics: score.metrics,
      cost_micro_usd: costMicroUsd,
    });
    return {
      task: task.name,
      version: task.version,
      model: model.id,
      score,
      cases: task.evalCases.length,
      costMicroUsd,
    };
  }

  return {
    async runTask(task, input, context) {
      const parsed = task.input.safeParse(input);
      if (!parsed.success) throw new AiTaskError('invalid_input', task.name);
      await assertRunning();
      const candidates = await route(task);
      if (candidates.length === 0) throw new AiTaskError('unavailable', task.name);

      const attempts: Attempt[] = [];
      for (const model of candidates) {
        if (!(await withinBudget(task, 'task'))) {
          throw new AiTaskError('budget', task.name, attempts);
        }
        try {
          const output = await attempt(task, model, parsed.data, 'task', context);
          attempts.push({ model: model.id, outcome: 'ok' });
          return output;
        } catch (error) {
          const failure = error instanceof ProviderFailure ? error.failure : 'server_error';
          attempts.push({ model: model.id, outcome: 'failed', failure });
          logger.warn('ai attempt failed', { task: task.name, model: model.id, failure });
        }
      }
      throw new AiTaskError('failed', task.name, attempts);
    },

    async verifyModels() {
      for (const provider of options.providers) {
        try {
          const listed = new Set(await provider.listModels());
          for (const model of models.filter((item) => item.provider === provider.provider)) {
            available.set(model.id, listed.has(model.id));
          }
        } catch (error) {
          // Unknown stays usable: a failing call will be classified and skipped.
          logger.warn('ai model list unavailable', {
            provider: provider.provider,
            failure: classifyError(error),
          });
        }
      }
      const result = Object.fromEntries(available);
      logger.info('ai models verified', { models: result });
      routes.clear();
      return result;
    },

    async evaluateMissing(tasks) {
      const reports: EvalReport[] = [];
      for (const task of tasks) {
        for (const model of usableModels(task)) {
          if ((await reportOf(task, model.id)) !== undefined) continue;
          try {
            reports.push(await evaluate(task, model.id));
          } catch (error) {
            logger.warn('ai eval not completed', {
              task: task.name,
              model: model.id,
              code: error instanceof AiTaskError ? error.code : undefined,
              error: error instanceof AiTaskError ? undefined : error,
            });
          }
        }
      }
      return reports;
    },

    async route(task) {
      return (await route(task)).map((model) => model.id);
    },

    evaluate,
    spend,
  };
}
