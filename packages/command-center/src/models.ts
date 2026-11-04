import { randomBytes } from 'node:crypto';
import {
  compareCandidate,
  isAdmitted,
  latestEvals,
  MODEL_REGISTRY,
  NOT_CHECKED,
  retiringModels,
  wishesMet,
  type ModelSpec,
  type TaskVerdict,
} from '@roi-dealer/ai-runtime';
import { timestampMs, type Actor, type Timestamp } from '@roi-dealer/domain';
import type { Database } from '@roi-dealer/database';
import {
  callbackButton,
  type CallbackContext,
  type CommandContext,
  type InlineKeyboard,
  type InlineKeyboardButton,
} from '@roi-dealer/telegram';
import { CONFIRMATION_TTL_MS } from './kill-switch.js';

/*
 * /models (09b, ADR-0014): the AI models, their passports and admission, candidates compared
 * with the admitted models on the same golden sets (code), retirements, capabilities processes
 * wait for and new ids the providers list. The owner admits or rejects a candidate.
 */

export const MODELS_PREFIX = 'md';
const MAX_PENDING = 20;
const DAY_MS = 86_400_000;

const MODALITY_LABELS: Readonly<Record<string, string>> = {
  text: 'текст',
  image_in: 'картинки на входе',
  video_in: 'видео на входе',
  audio_in: 'звук на входе',
  image_out: 'картинки на выходе',
  audio_out: 'голос на выходе',
};

const VERDICT_LABELS: Readonly<Record<TaskVerdict, string>> = {
  better: 'лучше',
  same: 'так же',
  worse: 'хуже',
  failed: 'эталон не пройден',
  no_report: 'эталон ещё не прогнан',
};

const checked = (value: string, labels: Readonly<Record<string, string>>) =>
  value === NOT_CHECKED ? 'не проверено' : (labels[value] ?? value);
const DATA_LABELS = { no_training: 'не для обучения', may_train: 'может идти в обучение' };
const RIGHTS_LABELS = { customer: 'ваши', restricted: 'с ограничениями' };

function passportLine(model: ModelSpec): string {
  const { passport } = model;
  return (
    `${model.id} · ${model.tier} · ${passport.modalities.map((item) => MODALITY_LABELS[item] ?? item).join(', ')}` +
    ` · данные: ${checked(passport.dataUse, DATA_LABELS)} · права: ${checked(passport.outputRights, RIGHTS_LABELS)}`
  );
}

const percent = (value: number) => `${String(Math.round(value * 100))}%`;
const dollars = (micro: number) => `$${(micro / 1_000_000).toFixed(4)}`;

export interface ModelsView {
  readonly text: string;
  readonly keyboard?: InlineKeyboard | undefined;
}

/** /models: what code knows about the models; buttons only for candidates. */
export async function modelsView(
  database: Database,
  nowMs: number,
  models: readonly ModelSpec[] = MODEL_REGISTRY,
): Promise<ModelsView> {
  const [decisions, assets, fresh] = await Promise.all([
    database.models.decisions(),
    database.repositories.knowledgeAssets.listByTags(['eval'], { limit: 1_000 }),
    database.models.newModels(),
  ]);
  const evals = latestEvals(assets.map((asset) => ({ tags: asset.tags, body: asset.body })));
  const admitted = models.filter((model) => isAdmitted(model, decisions));
  const candidates = models.filter(
    (model) => model.admission === 'candidate' && decisions.get(model.id) === undefined,
  );
  const lines = ['🤖 Модели AI — место решают эталоны (ADR-0014)', '', 'Допущены:'];
  lines.push(...admitted.map((model) => `• ${passportLine(model)}`));
  const keyboard: (readonly InlineKeyboardButton[])[] = [];
  lines.push('');
  if (candidates.length === 0) {
    lines.push('Претендентов нет — их добавляет model-scout после проверки условий.');
  }
  for (const candidate of candidates) {
    const comparison = compareCandidate(candidate, models, decisions, evals);
    lines.push(`🆕 Претендент: ${passportLine(candidate)}`);
    for (const item of comparison.tasks) {
      const own =
        item.candidate === undefined
          ? ''
          : ` точность ${percent(item.candidate.quality)}, ${dollars(item.candidate.costMicroUsd)}`;
      const current =
        item.current === undefined
          ? ''
          : ` (сейчас ${item.current.model}: ${percent(item.current.result.quality)}, ${dollars(item.current.result.costMicroUsd)})`;
      lines.push(`  ${item.task}:${own}${current} — ${VERDICT_LABELS[item.verdict]}`);
    }
    lines.push(
      comparison.recommend
        ? '  Рекомендация кода: допустить.'
        : '  Рекомендация кода: пока нет — не лучше на эталонах или они не прогнаны.',
    );
    keyboard.push([
      callbackButton(`✅ Допустить ${candidate.id}`, `${MODELS_PREFIX}:a:${candidate.id}`),
      callbackButton('✖️ Отклонить', `${MODELS_PREFIX}:r:${candidate.id}`),
    ]);
  }
  const retiring = retiringModels(models, nowMs);
  if (retiring.length > 0) {
    lines.push('');
    for (const { model, inDays } of retiring) {
      lines.push(
        inDays <= 0
          ? `⚠️ ${model.id} снят с поддержки — задачи перейдут на следующую модель по эталонам.`
          : `⚠️ ${model.id} снимут ${model.passport.retiresOn ?? ''} (через ${String(inDays)} дн.) — замена по эталонам.`,
      );
    }
  }
  const wishes = wishesMet(models, decisions).filter((item) => item.models.length > 0);
  if (wishes.length > 0) {
    lines.push('', '💡 Возможности, которых ждут процессы:');
    for (const { wish, models: able } of wishes) {
      lines.push(`• ${wish.process} — умеют: ${able.join(', ')}`);
    }
    lines.push('Новый процесс — только отдельной фазой; решаете вы.');
  }
  if (fresh.length > 0) {
    lines.push('', '🆕 У провайдеров новые модели (нет в реестре):');
    lines.push(
      ...fresh
        .slice(0, 10)
        .map((item) => `• ${item.provider}: ${item.modelId} · ${item.firstSeenAt.slice(0, 10)}`),
      'model-scout проверит условия и цены; претендент появится здесь после PR в реестр.',
    );
  }
  lines.push('', 'Порядок допущенных моделей в каждой задаче меняется сам — по эталонам (D-021).');
  return { text: lines.join('\n'), ...(keyboard.length === 0 ? {} : { keyboard }) };
}

/** One digest line once a provider lists models that are not in the registry. */
export async function modelsDigestLine(
  database: Pick<Database, 'models'>,
  nowMs: number,
): Promise<string | undefined> {
  const fresh = (await database.models.newModels()).filter(
    (item) => Date.parse(item.firstSeenAt) > nowMs - DAY_MS,
  );
  return fresh.length === 0
    ? undefined
    : `🆕 Новых моделей у провайдеров за сутки: ${String(fresh.length)} → /models`;
}

export interface ModelsFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (userId: number) => Actor;
  readonly models?: readonly ModelSpec[] | undefined;
}

export interface ModelsFlow {
  readonly models: (context: CommandContext) => Promise<void>;
  readonly handleButton: (context: CallbackContext) => Promise<void>;
}

export function createModelsFlow(deps: ModelsFlowDeps): ModelsFlow {
  const registry = deps.models ?? MODEL_REGISTRY;
  const pending = new Map<
    string,
    { modelId: string; decision: 'admitted' | 'rejected'; expiresAtMs: number }
  >();
  const nowMs = (): number => timestampMs(deps.now());

  return {
    async models(context) {
      const view = await modelsView(deps.database, nowMs(), registry);
      await context.reply(view.text, view.keyboard);
    },

    async handleButton(context) {
      const [, action, value] = context.data.split(':');
      if (action === 'a' || action === 'r') {
        const model = registry.find((item) => item.id === value && item.admission === 'candidate');
        if (model === undefined) {
          await context.edit('Претендент не найден.');
          return;
        }
        const current = nowMs();
        for (const [nonce, item] of pending) {
          if (item.expiresAtMs <= current) pending.delete(nonce);
        }
        while (pending.size >= MAX_PENDING) {
          const oldest = pending.keys().next().value;
          if (oldest === undefined) break;
          pending.delete(oldest);
        }
        const nonce = randomBytes(8).toString('hex');
        const decision = action === 'a' ? 'admitted' : 'rejected';
        pending.set(nonce, {
          modelId: model.id,
          decision,
          expiresAtMs: current + CONFIRMATION_TTL_MS,
        });
        await context.edit(
          decision === 'admitted'
            ? `✅ Допустить ${model.id} к реальным задачам?\n${passportLine(model)}\nПорядок в задачах дальше решают эталоны. Подтверждение действует 10 минут.`
            : `✖️ Отклонить ${model.id}? Он не будет ни работать, ни проходить эталоны. Подтверждение действует 10 минут.`,
          [
            [
              callbackButton(
                decision === 'admitted' ? '✅ Да, допустить' : '✖️ Да, отклонить',
                `${MODELS_PREFIX}:y:${nonce}`,
              ),
              callbackButton('Отмена', `${MODELS_PREFIX}:n:${nonce}`),
            ],
          ],
        );
        return;
      }
      const confirmation = value === undefined ? undefined : pending.get(value);
      if (action === 'n' && value !== undefined) {
        pending.delete(value);
        await context.edit('Отменено. Ничего не записано.');
        return;
      }
      if (action !== 'y' || confirmation === undefined || confirmation.expiresAtMs <= nowMs()) {
        await context.edit('⌛ Подтверждение устарело. Повторите /models.');
        return;
      }
      const actor = deps.owner(context.userId);
      await deps.database.command(
        {
          name: 'models.admission',
          idempotencyKey: `tg-callback-${context.callbackQueryId}`,
          correlationId: `tg-update-${String(context.updateId)}`,
        },
        async (scope) => {
          await scope.models.decide({
            modelId: confirmation.modelId,
            decision: confirmation.decision,
            actorId: actor.id,
            correlationId: `tg-update-${String(context.updateId)}`,
          });
          return { modelId: confirmation.modelId };
        },
      );
      pending.delete(value ?? '');
      await context.edit(
        confirmation.decision === 'admitted'
          ? `✅ ${confirmation.modelId} допущен. Маршрут обновится в течение часа.`
          : `✖️ ${confirmation.modelId} отклонён.`,
      );
    },
  };
}
