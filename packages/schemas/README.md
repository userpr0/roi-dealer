# @roi-dealer/schemas

**Статус:** реализован (PHASE 01).

Boundary contracts: всё, что приходит извне (API, Telegram-бот, AI-агенты, интеграции), проверяется здесь до передачи в доменные фабрики.

| Export                          | Назначение                                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createInputSchemas`            | Строгие схемы создания для 13 сущностей (`source`, `evidence`, …, `knowledgeAsset`). Лишние поля и поля сервера (`id`, `status`, `version`, времена, `createdBy`) отклоняются, в том числе во вложенных объектах. |
| `approvalDecisionInputSchema`   | Ответ владельца на запрос одобрения: `approve` / `reject` + комментарий.                                                                                                                                          |
| `contributionReviewInputSchema` | Проверка вклада владельцем: `verify` / `reject` + заметка.                                                                                                                                                        |
| `parseInput(schema, raw)`       | Типизированный результат или `InputValidationError` (пути и сообщения, без значений).                                                                                                                             |

```ts
const data = parseInput(createInputSchemas.hypothesis, untrustedJson);
const hypothesis = createHypothesis(data, { id, actor, at });
```

Далее (PHASE 03+) здесь появятся контракты событий, API-ответов и structured outputs AI-задач.
