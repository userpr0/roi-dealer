# @roi-dealer/ai-runtime

**Статус:** реализован (PHASE 09 — AI Runtime, [спецификация](../../docs/phases/09_ai_runtime.md), [ADR-0006](../../docs/ADR/0006-ai-providers-and-runtime.md), D-021).

## Назначение

Единственная точка вызова AI для агентов, судей и задач: `runTask(task, input, context)`. Пакет отвечает за:

- провайдеров Claude, GPT и Gemini за общим интерфейсом;
- маршрут по результатам evals;
- проверку ответа схемой;
- бюджет и журнал `ai_calls`.

## Правила

- **Только через `runTask`.** Код вне пакета не импортирует SDK провайдеров. Домен к провайдеру не привязан (§2.4).
- **Новая AI-задача** — объект `AiTask`:
  - имя и версия промпта;
  - Zod-схемы входа и выхода;
  - уровень `bulk` / `strong`;
  - `maxOutputTokens` и `maxCostMicroUsd` — худшая стоимость вызова на любой модели уровня;
  - `dailyShare` — доля дня; сумма долей всех задач и evals ≤ 1;
  - эталонный набор от 20 примеров и функция оценки.
- **Задача добавляется в `AI_TASKS`.** Worker сам прогонит её evals.
- **Новая версия промпта** — новый `version`: без своего проходного отчёта она не выполняется.
- **AI только предлагает (§2.3).** Результат проверяет и применяет код вызывающего — как `applyNameRedaction` для `redact-names`.
- **В тестах — только локальные фейки** API (`tests/support/fake-ai.ts`), никогда настоящие ключи.

## Export surface

| Что                                                                       | Зачем                                                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `createAiRuntime`                                                         | `runTask`, `evaluate`, `evaluateMissing`, `verifyModels`, `route`, `spend` |
| `createAnthropicProvider`, `createOpenAiProvider`, `createGoogleProvider` | Адаптеры официальных SDK                                                   |
| `MODEL_REGISTRY`, `routingOrder`, `callCostMicroUsd`                      | Реестр моделей, порядок по evals, цена вызова                              |
| `createAiMaintenance`, `recordDailyAiCost`                                | Часовое обслуживание в worker и ежедневная `CostEntry`                     |
| `AI_TASKS`, `redactNamesTask`, `redactNames`, `applyNameRedaction`        | Задачи; первая — вычистка имён в Evidence                                  |
| `AiTaskError`, `ProviderFailure`, `classifyError`, `parseOutput`          | Ошибки и классы сбоев                                                      |
