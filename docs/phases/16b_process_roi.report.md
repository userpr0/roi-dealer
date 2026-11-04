# 16b REPORT — «ROI процесса»

> **Спецификация:** [16b_process_roi.md](16b_process_roi.md). **Основание:** D-030. **Статус:** PASS.

## Implemented

- `database.economics.processOutputs(period)` — расход AI по задачам (эталоны отдельно) и результаты периода: подтверждённые боли, возможности, одобренные владельцем, гипотезы, одобренные лендинги, заявки.
- `@roi-dealer/economics`: реестр `PROCESSES`, `processRoi` (вердикт кодом), `processReport` (текущий или прошлый месяц UTC).
- Бот: `/roi`, `/roi прошлый`; строка в дайджесте 1-го числа; `/help` и меню команд.

## Files created

- `packages/economics/src/process-roi.ts`, `packages/command-center/src/roi.ts`
- `tests/unit/economics/process-roi.test.ts`, `tests/integration/economics/process-roi.test.ts`
- `docs/phases/16b_process_roi.md`, `docs/phases/16b_process_roi.report.md`

## Files modified

- `packages/database/src/economics.ts`, `index.ts`; `packages/economics/src/index.ts`
- `packages/command-center/src/command-center.ts`, `digest.ts`, `index.ts`; `apps/bot/src/commands.ts`
- `tests/integration/bot/process.test.ts` (меню команд)

## Tests

- `pnpm test`: 95 файлов, 919 тестов — PASS; `typecheck`, `lint`, `format:check` — PASS.

## Not implemented (Feature Kill Gate)

- Кнопки решений по процессу — после первых месяцев данных.
- Стоимость и итог каждого ролика Gen_Content — фаза 24.
