# @roi-dealer/opportunities

**Статус:** реализован (PHASE 07 — Opportunity Engine, [спецификация](../../docs/phases/07_opportunity_engine.md)).

## Назначение

Агент `opportunity-analyst` превращает повторяющиеся боли (от 2 сигналов) в черновики возможностей:

1. AI-задача `frame-opportunity` формулирует возможность по §2.17 (проблема → изменение → измеримый результат) и отмечает признаки: покупатель, повторяемость, срочность, ручная работа, цитаты о деньгах.
2. Код оставляет только цитаты, найденные в Evidence.
3. Код считает оценку 0–100 (`scoreOpportunity`) и выбирает первую бизнес-модель (`routeBusinessModel`).
4. При оценке ≥ 55 создаётся `Opportunity` в статусе `draft`.

## Правила

- **Доступ:** агент работает только через свою личность. Доступ выдаёт владелец в `/decisions`.
- **Числа считает код** по данным БД (§2.13). AI не выдумывает размеры рынков и цены.
- **Оценка:** каждая версия боли оценивается один раз — журнал `opportunity_assessments`.
- **Бюджет:** доля дня AI — 10 %. Стоп-кран проверяется первым шагом.
- **Решения** о возможностях принимает только владелец (PHASE 12). Агент создаёт черновики.

## Export surface

| Что                                                            | Зачем                                    |
| -------------------------------------------------------------- | ---------------------------------------- |
| `assessPains`, `createOpportunitiesScheduler`                  | Один запуск оценки и расписание в worker |
| `scoreOpportunity`, `SCORE_WEIGHTS`, `OPPORTUNITY_THRESHOLD`   | Оценка 0–100 и порог черновика           |
| `routeBusinessModel`, `ROUTING_REASONS`                        | Business Model Router                    |
| `frameOpportunityTask`, `toOpportunityDraft`, `verifiedQuotes` | AI-задача и проверка её ответа кодом     |
| `OPPORTUNITY_ANALYST`, `OPPORTUNITY_ANALYST_ACCESS`            | Личность агента и текст запроса доступа  |
