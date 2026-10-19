# @roi-dealer/agents

**Статус:** реализован (PHASE 10 — Agents, [спецификация](../../docs/phases/10_agents.md)).

## Назначение

- **Общие правила агентов:**
  - `AgentDefinition` — личность, запрос доступа, AI-задачи, один запуск;
  - `runAgent` — стоп-кран → запрос доступа → работа → строка в `agent_runs`;
  - `createAgentScheduler` — один планировщик на всех, запуски по очереди.
- **Агенты:**
  - `painAnalystAgent` — агент болей (PHASE 06, `@roi-dealer/signals`);
  - `opportunityAnalystAgent` — агент возможностей (PHASE 07, `@roi-dealer/opportunities`);
  - `researcherAgent` — поисковый запрос по боли (`research-query`) → посты Ask HN через HN Search и `collectEvidence`;
  - `marketAnalystAgent` — альтернативы, суммы и покупатели из Evidence возможности (`market-context`) → знание `market_data`.

## Правила

- **Агент только предлагает:** кандидаты, черновики и знания — через домен. Решения, деньги и доступы — нет (§2.3).
- **AI — только через `runTask`** (`@roi-dealer/ai-runtime`), у каждой задачи эталон от 20 примеров и доля дня.
- **Код проверяет ответ модели:**
  - запрос — только буквы, цифры и пробелы;
  - пункт рынка — только с цитатой, найденной в названном Evidence;
  - суммы — из цитаты, не от модели (§2.13).
- **Одна версия объекта — одна работа агента** (`agent_work`).
