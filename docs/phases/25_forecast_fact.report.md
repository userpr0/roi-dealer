# 25 REPORT — «Прогноз и факт»

> **Спецификация:** [25_forecast_fact.md](25_forecast_fact.md). **Основание:** D-033, ADR-0013. **Статус:** PASS.

## Implemented

- `@roi-dealer/domain`: `launchForecast`, `forecastProbability` (правила v1), `calibration` (Brier по версиям правил), `FORECAST_RULES_VERSION`, `WEIGHTS_PROPOSAL_MIN_OUTCOMES = 20`.
- `database.forecasts`: `record`, `recordOutcome` (false для теста без прогноза), `list`.
- Пульт: прогноз записывается при запуске теста и показывается владельцу («🎯 Прогноз кода: успех с вероятностью 62 %»); факт — при итоге; точность в `/roi` и в недельном разборе.
- CLAUDE.md: правило прогнозов; короткие ответы владельцу.

## Files created

- `database/migrations/0022_forecasts.sql`
- `packages/domain/src/forecast.ts`, `packages/database/src/forecasts.ts`
- `tests/unit/domain/forecast.test.ts`
- `docs/phases/25_forecast_fact.md`, `docs/phases/25_forecast_fact.report.md`

## Files modified

- `packages/domain/src/index.ts`; `packages/database/src/database.ts`, `index.ts`
- `packages/command-center/src/experiments.ts`, `roi.ts`, `stats.ts`, `index.ts`
- `tests/integration/experiments/experiments.test.ts`, `tests/integration/database/migrations.test.ts`

## Database migrations

- `0022_forecasts`: `forecasts`, `forecast_outcomes` — только добавление (триггеры `reject_change`).

## Tests

- Unit: вероятность в пределах 5–95 %, входы правил, Brier, «не определена» вне точности, версии отдельно, тексты `/roi`.
- Integration: прогноз при запуске и факт при итоге двух тестов, `/roi` с Brier 0.26; повторы и правка журнала отклоняются; факт против вердикта отклоняется.
- `pnpm test` (все unit и integration): 97 файлов, 935 тестов — PASS; `typecheck`, `lint`, `format:check` — PASS.

## Not implemented (Feature Kill Gate)

- Предложение новых весов карточкой — после 20 итогов.
- Ожидаемая конверсия в прогнозе.

## Next

- Фаза 26 «Портфель» — после ответа владельца (D-033).
