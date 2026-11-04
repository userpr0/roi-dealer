# 26 REPORT — «Портфель»

> **Спецификация:** [26_portfolio.md](26_portfolio.md). **Основание:** D-034, ADR-0013. **Статус:** PASS.

## Implemented

- `@roi-dealer/domain`:
  - `stopping.ts`: `betaCdf`, `rateAtLeastProbability`, `countReachProbability`, `stoppingEvidence`, `clearlyBelowTarget`, `clearlyAboveTarget`;
  - `STOP_REASONS.futility` — `automaticStopReason` с цифрами воронки, вердикт «опровергнута», предложение «сменить подход»;
  - `portfolio.ts`: `portfolioLimitsSchema`, `portfolioPosterior`, `recommendPortfolio` (сэмплирование Томпсона с зерном месяца).
- `database.portfolio`: `setBudget`, `budget(month)`, `committed(period)`.
- Пульт:
  - `/allocate` — бюджет, занято, рекомендация; `/allocate 300 страна 150 возможность 100` — подтверждение и запись;
  - строка портфеля в вопросе о запуске;
  - «Шанс дойти до цели» на карточке теста;
  - автоматическая остановка «явно хуже» в `/funnel`.

## Files created

- `database/migrations/0023_portfolio.sql`
- `packages/domain/src/stopping.ts`, `packages/domain/src/portfolio.ts`
- `packages/database/src/portfolio.ts`, `packages/command-center/src/allocate.ts`
- `tests/unit/domain/portfolio.test.ts`
- `docs/phases/26_portfolio.md`, `docs/phases/26_portfolio.report.md`

## Files modified

- `packages/domain/src/entities/experiment.ts`, `index.ts`
- `packages/database/src/database.ts`, `index.ts`
- `packages/command-center/src/experiments.ts`, `command-center.ts`, `roi.ts`, `index.ts`; `apps/bot/src/commands.ts`
- `tests/integration/experiments/experiments.test.ts`, `tests/integration/database/migrations.test.ts`, `tests/integration/bot/process.test.ts`

## Database migrations

- `0023_portfolio`: `portfolio_budgets` — только добавление.

## Tests

- Unit:
  - бета-распределение по точным формулам;
  - шанс доли и счёта;
  - защита от малых данных;
  - ранняя остановка и вердикт;
  - одинаковая рекомендация в течение месяца, лимиты, причины пропуска, сдвиг шанса по итогам;
  - разбор `/allocate`.
- Integration: `/allocate` без бюджета, с ошибкой, подтверждение и запись, рекомендация; строка портфеля при запуске; «Шанс дойти до цели: 41 %» на карточке.
- `pnpm test`: 97 файлов, 938 тестов — PASS; `typecheck`, `lint`, `format:check` — PASS.

## Not implemented (Feature Kill Gate)

- Запрет запуска сверх портфеля — только предупреждение.
- Шанс по методу и стране отдельно — после накопления тестов.

## Next

- Фаза 09b «Смена моделей по тестам» (D-034).
