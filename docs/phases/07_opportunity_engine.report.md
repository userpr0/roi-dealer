# PHASE 07 REPORT — Opportunity Engine

```text
Phase: 07 — Opportunity Engine
Status: PASS
Date: 2026-10-19
Spec: docs/phases/07_opportunity_engine.md (составлена Claude по D-020)
Approval mode: D-020 — фазы до Уровня 2 одобрены; следующая — PHASE 08 Company Brain v0.1
```

## Implemented

- **Агент `opportunity-analyst`** (`@roi-dealer/opportunities`, новый пакет):
  - доступ — через `/decisions`;
  - стоп-кран — первым шагом;
  - берёт до 5 открытых болей с ≥ 2 сигналами, версия которых ещё не оценена.
- **AI-задача `frame-opportunity`** (bulk, доля дня 10 %, 20 эталонов) — формулирует возможность по §2.17:
  - заголовок, описание, ICP;
  - проблема, изменение, измеримый результат;
  - признаки: покупатель, повторяемость, срочность, ручная работа;
  - цитаты о деньгах, гипотеза цены.
- **Проверка кодом:**
  - засчитываются только цитаты о деньгах, найденные в Evidence. Одна и та же цитата в другом регистре считается один раз — иначе AI мог бы завысить оценку;
  - неполное ценностное предложение → `rejected`.
- **Оценка 0–100 в коде:** частота 25, тяжесть 20, источники 15, готовность платить 20, рынки D-008 10, покупатель 10. При ≥ 55 создаётся черновик `Opportunity`, ниже — итог `below_threshold`.
- **Business Model Router:** таблица в коде выбирает первую гипотезу монетизации — `service`, `subscription`, `one_time` или `free_limit`.
- **Миграция `0008`:** журнал `opportunity_assessments`, одна строка на версию боли, в одной транзакции с возможностью. Выросшая боль оценивается заново.
- **Домен:** `TARGET_MARKETS` (D-008), общий для болей и возможностей.
- **Пульт:**
  - `/opportunities` — лучшие черновики: оценка и её составляющие, модель, рынки, боль. Право `research.read`;
  - строка дайджеста.
- **Worker:** агент раз в час при AI-ключах. Процесс-тест проходит путь «пост → доказательство → боль из 2 сигналов → черновик возможности».

## Files created

- `packages/opportunities/`:
  - `src/{assess,scheduler,scoring,business-model,index}.ts`;
  - `src/tasks/frame-opportunity.ts`;
  - `package.json`, `tsconfig.json`, `README.md`.
- `packages/database/src/opportunity-assessments.ts`.
- `packages/command-center/src/opportunities.ts`.
- `packages/domain/src/markets.ts`.
- `database/migrations/0008_opportunity_engine.sql`.
- `tests/unit/opportunities/opportunities.test.ts`, `tests/integration/opportunities/assess.test.ts`.
- `docs/phases/07_opportunity_engine.md`, этот отчёт.

## Files modified

- **База:** `database.opportunityAssessments` — на пуле и в транзакции.
- **Сигналы:** рынки по умолчанию — `TARGET_MARKETS`.
- **Пульт:** `/opportunities`, строка дайджеста; бот — `/opportunities` в `/help`.
- **Worker:** `OPPORTUNITIES_INTERVAL_MS`, запуск агента, evals задачи `frame-opportunity`.
- **Корень:** `package.json`, `tsconfig.json`, `pnpm-lock.yaml`.
- **Тесты:**
  - список миграций, импорты пакетов;
  - меню бота, `/opportunities` в пульте;
  - процесс worker.
- **Документы:**
  - `CURRENT_STATE.md`, `ROADMAP.md`, `SYSTEM_ARCHITECTURE.md`, ADR-0006 (доли дня);
  - `phases/README.md`, `CLAUDE.md`;
  - `deploy/worker.md`, runbook удаления данных;
  - `database/docs/schema.md`, `database/migrations/README.md`.

## Database migrations

- **`0008_opportunity_engine`** — `opportunity_assessments`, только добавление:
  - поля: боль и версия (уникально), версия задачи, итог, оценка 0–100 и составляющие (`jsonb`-объект), возможность, актор, `correlation_id`;
  - CHECK: возможность ровно у `opportunity`, оценка ровно у оценённых итогов;
  - триггеры запрета изменения, удаления и `TRUNCATE`.

## Tests added

- **Unit:**
  - веса 100 и порог 55;
  - примеры оценок, включая минимум и максимум;
  - все строки таблицы Business Model Router;
  - проверка цитат о деньгах: выдуманные отсекаются, повтор в другом регистре считается один раз, не больше трёх;
  - неполное предложение отклоняется;
  - сборка возможности: оценка и модель в описании, доказательство, ICP по умолчанию;
  - эталон: состав, идеальные ответы проходят, неверный покупатель и выдуманные цитаты — нет;
  - доли дня всех задач ≤ 1, резерв покрывает худший вызов.
- **Integration (PostgreSQL, фейковый Claude):**
  - доступ через `/decisions`;
  - eval;
  - черновик с оценкой 62 и подписочной моделью;
  - выдуманная цитата не засчитана;
  - `below_threshold` с оценкой;
  - `rejected`;
  - боль с одним сигналом не берётся;
  - повтор без затрат, выросшая боль — повторная оценка;
  - стоп-кран, недоступный AI, сбой моделей;
  - `/opportunities` и дайджест;
  - тексты постов не попадают в логи.
- **Процесс worker:** два поста → одна боль из двух сигналов → черновик возможности от агента.

## Test results

| Проверка            | Результат                                                         |
| ------------------- | ----------------------------------------------------------------- |
| `pnpm typecheck`    | pass                                                              |
| `pnpm lint`         | pass (0 warnings)                                                 |
| `pnpm format:check` | pass                                                              |
| `pnpm test`         | 55 файлов, 624 теста — pass (unit 432, integration 192); было 597 |
| `pnpm build`        | pass                                                              |

Тесты поймали две ошибки:

- повтор цитаты завышал оценку;
- составляющие оценки выводились вразнобой: `jsonb` не хранит порядок ключей, и `/opportunities` теперь выводит их в порядке спецификации.

Обе исправлены.

## Security implications

- **Агент:**
  - отдельная личность с правом `research.write`;
  - создаёт только черновики;
  - решения о возможностях принимает только владелец (PHASE 12, домен: `applyOpportunityDecision`).
- **Числа не приходят от AI** (§2.13): оценку и модель считает код, деньги засчитываются только по найденным цитатам.
- **Подтверждённые цитаты** сохраняются в `value_proof`. Runbook удаления данных учитывает и их.

## Cost implications

- **Одна формулировка возможности:** ≈ $0.002 на самой дешёвой модели. Агент берёт до 5 болей в час, только с 2+ сигналами. Доля дня — 10 %.
- **Первый прогон эталона** (20 примеров на трёх моделях) — около $0.05.
- **Доли дня всех AI-задач теперь:**
  - вычистка имён 10 %;
  - боли 20 %;
  - возможности 10 %;
  - evals 20 %;
  - резерв на агентов и судей — 40 %.

## Known limitations

- **Рыночный контекст — только из доказательств:** рынки, число источников. Размеры рынков, конкуренты и цены конкурентов — агент контекста рынка (PHASE 10).
- **Веса оценки заданы спецификацией.** Калибровка — по результатам экспериментов (PHASE 15–16).
- **Одна возможность на боль.** Если боль сильно вырастет после черновика, новая возможность не создаётся — это решение для PHASE 12.

## Technical debt

- Планировщики агентов болей и возможностей почти одинаковы. Общий планировщик агентов — в PHASE 10.

## Architecture deviations

- Нет. Новый пакет `@roi-dealer/opportunities` по образцу PHASE 05–06, без Temporal.

## Scope decisions

- **`frame-opportunity` — задача уровня `bulk`.** Признаки извлекаются, а суждение о возможности выносят судьи (PHASE 11, `strong`). Прогон эталона сильных моделей стоил бы около $3 и занял бы десять дней доли evals.
- **Без кнопок решения:** карточка с ✅ / ❌ — PHASE 12, после судей.

## Business hypothesis enabled by this phase

Вместо списка жалоб владелец видит короткий список возможностей:

- с оценкой и её причинами;
- с клиентом и измеримым результатом;
- с первой моделью монетизации;
- с цитатами, которые показывают, что люди уже платят за проблему.

## Authoritative data paths verified

```text
Pain (≥ 2 signals) + Evidence → runTask(frame-opportunity) → toOpportunityDraft + verifiedQuotes
→ scoreOpportunity → routeBusinessModel → одна транзакция: Opportunity (draft) + opportunity_assessments
→ /opportunities, дайджест, /journal
```

## Ready for next phase

- **Да.** По D-020 следующая — **PHASE 08 Company Brain v0.1**.
- **Действия владельца:** влить PR. Когда в worker появятся ключи AI, одобрить «Доступ: Агент возможностей».
