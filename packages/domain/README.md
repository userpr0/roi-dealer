# @roi-dealer/domain

**Статус:** placeholder (PHASE 00). Реализация — PHASE 01 — Core Domain.

## Назначение

Доменные сущности и value objects ROI Dealer: Source, Evidence, Signal, Pain, Opportunity, Hypothesis, Experiment, Product, Contribution, Reward и т.д.

## Правила

- Чистый TypeScript без I/O: никакого доступа к БД, сети, AI providers.
- Инварианты и state transitions описываются здесь, а проверяются backend-кодом.

## Текущий export surface

- `PACKAGE_NAME` — идентификатор пакета (используется в import-тестах).

Не добавлять логику до одобрения соответствующей Phase владельцем.
