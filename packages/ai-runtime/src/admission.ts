import { modelTag, type Modality, type ModelSpec } from './models.js';

/*
 * Model changes by tests (09b, ADR-0014): a candidate model is compared with the admitted ones
 * on the same golden sets, in code; the owner admits it in /models. Capabilities that processes
 * wait for are matched against the passports.
 */

export type ModelDecision = 'admitted' | 'rejected';

/** A stored eval report as the knowledge base keeps it (tags and JSON body). */
export interface StoredEval {
  readonly tags: readonly string[];
  readonly body?: string | undefined;
}

export interface EvalResult {
  readonly passed: boolean;
  readonly costMicroUsd: number;
  /** Mean of the metrics, in [0, 1]. */
  readonly quality: number;
}

/** The latest report per task (its newest version) and per model tag; `evals` newest first. */
export function latestEvals(
  evals: readonly StoredEval[],
): ReadonlyMap<string, ReadonlyMap<string, EvalResult>> {
  const versions = new Map<string, number>();
  const parsed = evals.flatMap((item) => {
    const task = item.tags.find((tag) => tag.startsWith('task-'))?.slice(5);
    const version = Number(item.tags.find((tag) => tag.startsWith('v-'))?.slice(2));
    const model = item.tags.find((tag) => tag.startsWith('model-'));
    if (task === undefined || model === undefined || !Number.isInteger(version)) return [];
    versions.set(task, Math.max(versions.get(task) ?? 0, version));
    return [{ task, version, model, item }];
  });
  const result = new Map<string, Map<string, EvalResult>>();
  for (const { task, version, model, item } of parsed) {
    if (version !== versions.get(task)) continue;
    const own = result.get(task) ?? new Map<string, EvalResult>();
    if (!own.has(model)) own.set(model, readEval(item));
    result.set(task, own);
  }
  return result;
}

function readEval(item: StoredEval): EvalResult {
  let costMicroUsd = Number.MAX_SAFE_INTEGER;
  let metrics: number[] = [];
  try {
    const body = JSON.parse(item.body ?? '') as { costMicroUsd?: unknown; metrics?: unknown };
    if (typeof body.costMicroUsd === 'number') costMicroUsd = body.costMicroUsd;
    if (typeof body.metrics === 'object' && body.metrics !== null) {
      metrics = Object.values(body.metrics).filter((value) => typeof value === 'number');
    }
  } catch {
    // An unreadable body counts as the dearest and the worst.
  }
  return {
    passed: item.tags.includes('passed'),
    costMicroUsd,
    quality:
      metrics.length === 0 ? 0 : metrics.reduce((sum, value) => sum + value, 0) / metrics.length,
  };
}

/** Whether a model may serve real calls: standing unless rejected, a candidate once admitted. */
export function isAdmitted(
  model: Pick<ModelSpec, 'id' | 'admission'>,
  decisions: ReadonlyMap<string, ModelDecision>,
): boolean {
  const decision = decisions.get(model.id);
  return model.admission === 'standing' ? decision !== 'rejected' : decision === 'admitted';
}

export type TaskVerdict = 'better' | 'same' | 'worse' | 'failed' | 'no_report';

export interface TaskComparison {
  readonly task: string;
  readonly verdict: TaskVerdict;
  readonly candidate?: EvalResult | undefined;
  /** The admitted model that serves the task first now, by the tier's rule. */
  readonly current?: { readonly model: string; readonly result: EvalResult } | undefined;
}

export interface CandidateComparison {
  readonly model: ModelSpec;
  readonly tasks: readonly TaskComparison[];
  /** Code's advice: every task evaluated and passed, none worse, at least one better. */
  readonly recommend: boolean;
}

/**
 * The candidate against the admitted models of its tier on each task that has reports there:
 * better when as accurate and cheaper, or more accurate (the price stays inside D-007 anyway).
 */
export function compareCandidate(
  candidate: ModelSpec,
  models: readonly ModelSpec[],
  decisions: ReadonlyMap<string, ModelDecision>,
  evals: ReadonlyMap<string, ReadonlyMap<string, EvalResult>>,
): CandidateComparison {
  const peers = models.filter(
    (model) =>
      model.tier === candidate.tier && model.id !== candidate.id && isAdmitted(model, decisions),
  );
  const tasks: TaskComparison[] = [];
  for (const [task, byModel] of evals) {
    const passing = peers.flatMap((model) => {
      const result = byModel.get(modelTag(model.id));
      return result?.passed === true ? [{ model: model.id, result }] : [];
    });
    if (passing.length === 0) continue;
    const [current] = passing.sort((a, b) =>
      candidate.tier === 'bulk'
        ? a.result.costMicroUsd - b.result.costMicroUsd || b.result.quality - a.result.quality
        : b.result.quality - a.result.quality || a.result.costMicroUsd - b.result.costMicroUsd,
    );
    const own = byModel.get(modelTag(candidate.id));
    if (own === undefined) {
      tasks.push({ task, verdict: 'no_report', current });
      continue;
    }
    if (!own.passed || current === undefined) {
      tasks.push({ task, verdict: 'failed', candidate: own, current });
      continue;
    }
    const { quality, costMicroUsd } = current.result;
    const verdict: TaskVerdict =
      (own.quality >= quality && own.costMicroUsd < costMicroUsd) || own.quality > quality
        ? 'better'
        : own.quality === quality && own.costMicroUsd === costMicroUsd
          ? 'same'
          : 'worse';
    tasks.push({ task, verdict, candidate: own, current });
  }
  tasks.sort((a, b) => a.task.localeCompare(b.task));
  const recommend =
    tasks.length > 0 &&
    tasks.every((item) => item.verdict === 'better' || item.verdict === 'same') &&
    tasks.some((item) => item.verdict === 'better');
  return { model: candidate, tasks, recommend };
}

/** A capability a process waits for (ADR-0014); a new process still needs its own phase. */
export interface CapabilityWish {
  readonly key: string;
  readonly needs: Modality;
  /** The process that would use it, in the owner's words. */
  readonly process: string;
}

export const CAPABILITY_WISHES: readonly CapabilityWish[] = [
  {
    key: 'landing-screenshot',
    needs: 'image_in',
    process: 'проверка лендинга по скриншоту перед выпуском (Release Gate, PHASE 21)',
  },
  {
    key: 'video-pattern',
    needs: 'video_in',
    process: 'разбор ролика как набора параметров, не копии (паттерны хитов, этап G, §2.20)',
  },
  {
    key: 'voice',
    needs: 'audio_out',
    process: 'озвучка роликов (Gen_Content)',
  },
];

/** Each wish with the admitted or candidate models whose passport has the capability. */
export function wishesMet(
  models: readonly ModelSpec[],
  decisions: ReadonlyMap<string, ModelDecision>,
): readonly { readonly wish: CapabilityWish; readonly models: readonly string[] }[] {
  return CAPABILITY_WISHES.map((wish) => ({
    wish,
    models: models
      .filter(
        (model) =>
          model.passport.modalities.includes(wish.needs) && decisions.get(model.id) !== 'rejected',
      )
      .map((model) => model.id),
  }));
}

/** Models whose announced retirement is within `days` of `nowMs`. */
export function retiringModels(
  models: readonly ModelSpec[],
  nowMs: number,
  days = 30,
): readonly { readonly model: ModelSpec; readonly inDays: number }[] {
  return models.flatMap((model) => {
    const date = model.passport.retiresOn;
    if (date === undefined) return [];
    const inDays = Math.ceil((Date.parse(`${date}T00:00:00Z`) - nowMs) / 86_400_000);
    return inDays <= days ? [{ model, inDays }] : [];
  });
}
