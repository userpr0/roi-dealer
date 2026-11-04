# 09b REPORT — «Смена моделей по тестам»

> **Спецификация:** [09b_model_changes.md](09b_model_changes.md). **Основание:** D-034, ADR-0014. **Статус:** PASS.

## Implemented

- `@roi-dealer/ai-runtime`:
  - паспорт и допуск в `MODEL_REGISTRY`;
  - `admission.ts`: `isAdmitted`, `latestEvals`, `compareCandidate`, `CAPABILITY_WISHES`, `wishesMet`, `retiringModels`;
  - `withTraps`;
  - маршрут — только допущенные модели; эталоны — и для претендентов, кроме отклонённых;
  - запись списков моделей провайдеров.
- `database.models`: `decide`, `decisions`, `recordListed`, `newModels`; миграция `0024_model_admissions`.
- Пульт: `/models` с кнопками допуска и отклонения, с подтверждением; строка в дайджесте.
- `extract-signal`: 2 ловушки, `externalText`.

## Database migrations

- `0024_model_admissions`: `model_admissions` (только добавление), `provider_models`.

## Tests

- Unit:
  - паспорта;
  - допуск;
  - сравнение претендента;
  - возможности и снятие;
  - ловушки (обманутая модель не проходит);
  - число ловушек.
- Integration:
  - претендент проходит эталон, но не получает вызовов;
  - `/models` показывает претендента, допуск кнопкой с подтверждением открывает маршрут, журнал не правится;
  - база и новые id провайдера.
- `pnpm test`: 98 файлов, 945 тестов — PASS; `typecheck`, `lint`, `format:check` — PASS.

## Not implemented (Feature Kill Gate)

- Ловушки остальных задач с чужим текстом — со следующей версией каждой задачи.
- Навык `model-scout` — при первой новой модели.
