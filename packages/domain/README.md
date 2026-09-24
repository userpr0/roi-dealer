# @roi-dealer/domain

**Статус:** реализован (PHASE 01, [спецификация](../../docs/phases/01_core_domain.md)).

Доменная модель ROI CORE v0.1: сущности главного цикла, их жизненные циклы и правила. Чистый TypeScript + Zod: **без I/O**, без часов и случайности — время (`at`) и идентификаторы (`id`) передаёт вызывающий код.

## Сущности

| Сущность                   | Создание                                                   | Изменение                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source                     | `createSource`                                             | `changeSourceStatus`                                                                                                                                          |
| Evidence (immutable)       | `createEvidence`                                           | —                                                                                                                                                             |
| Signal                     | `createSignal`                                             | `changeSignalStatus`                                                                                                                                          |
| Pain                       | `createPain`                                               | `validatePain` (≥ 2 источника), `changePainStatus`                                                                                                            |
| Opportunity                | `createOpportunity`                                        | `submitOpportunityForReview`, `applyOpportunityDecision`, `startOpportunityValidation`, `archiveOpportunity`                                                  |
| Decision (immutable)       | `createDecision` (только owner)                            | —                                                                                                                                                             |
| ApprovalRequest            | `createApprovalRequest`                                    | `resolveApprovalRequest` (только owner, до `expiresAt`), `expireApprovalRequest`, `cancelApprovalRequest`                                                     |
| Hypothesis                 | `createHypothesis`, `assertDistinctHypothesisSet`          | `changeHypothesisStatus`                                                                                                                                      |
| Experiment                 | `createExperiment` (только для `selected` гипотезы)        | `requestExperimentApproval`, `approveExperiment`, `startExperiment`, `stopExperiment`, `completeExperiment`, `returnExperimentToPlanning`, `cancelExperiment` |
| CostEntry (immutable)      | `recordCostEntry` (human gate D-006)                       | сторно — новой записью `reversalOf`; итоги — `summarizeCosts`                                                                                                 |
| Contribution               | `createContribution`                                       | `reviewContribution` (только owner)                                                                                                                           |
| Reward                     | `calculateReward` (только verified-вклады одного человека) | `approveReward` (payout approval), `markRewardPayable`, `markRewardPaid`, `cancelReward`                                                                      |
| KnowledgeAsset (immutable) | `createKnowledgeAsset`                                     | новая версия — `supersedes`                                                                                                                                   |

## Общие элементы

- **Value objects:** branded UUID (`OpportunityId`, …), `Timestamp` (только UTC), `Money` (целые центы USD), `Actor` (`owner`, `member`, `agent`, `system`, `integration`), `EntityRef`, `Metric`.
- **State machines:** `defineStateMachine`; каждая изменяемая сущность экспортирует `…Lifecycle` и список статусов.
- **Политика одобрений:** `requiresOwnerApproval`, `DEFAULT_APPROVAL_POLICY` (порог $20, D-006), `assertApprovalCovers`.
- **Ошибки:** `DomainError` с кодом `invalid_transition` | `owner_required` | `evidence_required` | `approval_required` | `approval_expired` | `invariant_violation`; без значений полей.

## Правила использования

- Статус меняется **только** через функции пакета, никогда присваиванием поля.
- Функции не мутируют аргументы: возвращают новую версию (`version + 1`, `updatedAt = at`).
- Решения принимает только `owner`; AI-агент (`agent`) создаёт предложения.
- Идентификаторы генерируйте `uuidv7()` из `@roi-dealer/shared` и приводите схемой (`opportunityIdSchema.parse(uuidv7())`).
