# ROI Dealer — Constitution

> **Источник:** Implementation Playbook v1.1 — «Главный принцип» и §2 (текст ниже перенесён дословно).
> Полный playbook: [`docs/playbook/IMPLEMENTATION_PLAYBOOK_v1.1.md`](playbook/IMPLEMENTATION_PLAYBOOK_v1.1.md).
>
> **Статус:** действует. Изменение любого правила — только через ADR с approval владельца (§2.12).

## Главный принцип

> AI думает.
>
> Backend проверяет.
>
> PostgreSQL хранит authoritative state.
>
> Event History хранит историю.
>
> Temporal выполняет долгие workflows.
>
> Company Brain хранит знания.
>
> Владелец принимает стратегические решения.

Claude Code должен считать следующие правила архитектурными ограничениями.

## 2.1 Source of Truth

PostgreSQL является главным источником истины для бизнес-состояния.

Запрещено использовать как authoritative state:

- Telegram;
- чат AI;
- n8n;
- Temporal history;
- локальные JSON-файлы;
- prompt memory;
- внешний CRM.

## 2.2 Event History

Важная история бизнеса является append-only.

Событие нельзя переписывать или молча удалять. Исправление оформляется новым событием.

## 2.3 AI не изменяет authoritative business state напрямую

AI может вернуть предложение, оценку или структурированный результат, но не должен напрямую менять Opportunity, Experiment, Product, Reward, финансовый ledger или permissions.

Изменение состояния выполняется backend-кодом после:

- schema validation;
- permission check;
- policy check;
- budget check;
- state-transition validation;
- evidence requirements.

## 2.4 AI providers заменяемы

Нельзя привязывать доменную бизнес-логику к конкретной модели или провайдеру.

Бизнес-код должен вызывать абстрактную задачу:

```text
runTask(taskType, requirements, context)
```

Model Router выбирает подходящую модель.

## 2.5 Evidence First

Серьёзные AI-выводы должны ссылаться на Evidence. LLM output сам по себе не считается фактом.

## 2.6 Ограниченные автоматизации

Каждый workflow обязан иметь:

- max cost;
- timeout;
- retries;
- max AI calls;
- allowed external actions;
- stop conditions.

## 2.7 Human Gates

Критические действия требуют human approval:

- большие бюджеты;
- реальные выплаты;
- покупка активов;
- необратимые production changes;
- юридически чувствительные операции;
- high-risk deployments;
- доступ к секретам;
- изменения core policies.

## 2.8 Cost Accounting

С первого рабочего этапа учитывать стоимость AI, API, infrastructure, storage, media, ads, human work, refunds и vendors.

## 2.9 Every Cycle Leaves an Asset

Даже неуспешный эксперимент должен оставить хотя бы один актив: Evidence, Knowledge, Pattern, Skill, Asset, Failure Pattern, reusable code или market data.

## 2.10 Reward only from verified contribution

Reward связан цепочкой:

```text
Contributor
→ Contribution
→ Result
→ Verification
→ Reward Calculation
→ Approval
→ Payable
→ Paid
```

## 2.11 Security

Никогда не хранить реальные секреты в repository.

Использовать:

- environment variables только для локальной разработки;
- Secret Manager / Vault в production;
- least privilege;
- short-lived credentials;
- audit logs.

## 2.12 No silent architecture changes

Если Claude Code считает, что архитектурное решение нужно изменить, он обязан:

1. не менять его автоматически;
2. создать ADR proposal;
3. описать причину;
4. описать impact;
5. предложить альтернативы;
6. остановиться до approval владельца.

## 2.13 Retrieval Before Reasoning

Для любых authoritative-вопросов сначала получить факты из source of truth, затем формировать AI-ответ.

Это обязательно для:

- финансов;
- расходов и доходов;
- клиентов и сделок;
- статусов Opportunity / Hypothesis / Experiment / Product;
- Reward;
- пользовательских записей;
- фактической аналитики.

Запрещено отвечать на такие вопросы только из prompt memory, conversation memory или предположений модели.

Базовый порядок:

```text
User Question
→ classify intent
→ retrieve authorized records
→ validate freshness/completeness
→ reason over retrieved facts
→ answer with provenance
```

## 2.14 Minimum Sellable Product

До доказанного спроса Claude Code должен стремиться к минимальной безопасной версии продукта, за которую можно получить целевое действие или оплату.

Функция допускается в ранний продукт, если она:

1. решает подтверждённую боль; или
2. необходима для измеримого Customer Outcome; или
3. обязательна для безопасности, платежей, аналитики или надёжности; или
4. непосредственно нужна для проверки текущей гипотезы.

Иначе функция должна быть отложена в backlog.

## 2.15 Feature Kill Gate

Перед реализацией необязательной функции Claude должен указать:

- какую боль она решает;
- какую гипотезу проверяет;
- какую метрику изменяет;
- почему без неё нельзя провести текущий тест.

Если ответ отсутствует — функция не входит в текущий Phase.

## 2.16 Early User Crash Test

До масштабного или платного публичного трафика критические user journeys должны пройти тест реальными пользователями / design partners.

Обязательные проверки по применимости:

- happy path;
- пустые данные;
- неправильный ввод;
- повтор действия;
- потеря соединения;
- возврат после ошибки;
- retrieval из БД;
- платежный сценарий;
- лимиты;
- authorization;
- удаление/отмена;
- recovery.

Blocking-баги должны быть исправлены до public acquisition.

## 2.17 Outcome-first Product & Marketing

AI-возможность не считается самостоятельной ценностью.

Продукт, landing, demo и creative должны объяснять:

- проблему;
- изменение для пользователя;
- измеримый результат;
- доказательство результата.

Формулировка вида «AI-powered» не заменяет value proposition.

## 2.18 Monetization is a Hypothesis

Pricing и monetization тестируются как отдельные гипотезы:

- free limit / freemium;
- subscription;
- one-time purchase;
- setup fee;
- bundle;
- usage-based;
- outcome-based;
- lifetime deal.

Lifetime deal допускается как инструмент ранней validation/cash-flow, но Economics обязан учитывать будущую стоимость support, AI/API и инфраструктуры такого клиента.

## 2.19 Cheap Experiment, Strong Discipline

AI coding снижает стоимость попытки, но не отменяет:

- tests;
- security;
- source-of-truth discipline;
- audit;
- cost limits;
- release gates;
- rollback.

Цель — чаще проводить маленькие обратимые эксперименты, а не быстрее создавать технический долг.

---

## Поправки владельца

Принципы, добавленные после playbook v1.1 решением владельца. Действуют наравне с §2.1–2.19.

## 2.20 Abstract the pattern, do not blindly copy the artifact

> [ADR-0004](ADR/0004-constitution-pattern-and-permitted-access.md), 2026-09-24.

Извлекай рабочий паттерн, а не копируй исходный материал. Это относится к видео, сайтам, рекламным креативам, продуктам, конкурентам и бизнес-моделям.

- Сначала проверка прав на материал; права на видео и на аудио проверяются отдельно, права на коммерческое использование — где требуется.
- В систему попадают структурированные параметры (например, `MotionSpec`, структура лендинга, модель монетизации), а не копия исходника.
- Без подтверждённых прав — только абстрактное исследование паттерна, где это законно. Публиковать скопированные видео, аудио, тексты и изображения запрещено.
- Внутреннее представление не привязывается к формату конкретного провайдера.

## 2.21 Permitted access only

> [ADR-0004](ADR/0004-constitution-pattern-and-permitted-access.md), 2026-09-24.

Внешние сервисы, данные и модели используются только разрешёнными способами: официальные API, подписки, pay-as-you-go, бесплатные лимиты в пределах правил сервиса.

Запрещено: мультиаккаунты, антидетект-браузеры, обход лимитов, капч и защит, сбор данных в нарушение условий площадки, использование чужих учётных данных.

Оптимизатор стоимости сравнивает только разрешённые варианты (бесплатный лимит, официальный API, подписка, pay-as-you-go, альтернативный провайдер) и выбирает минимальную стоимость успешного результата.

---

## Применение в repository (состояние на PHASE 03)

| Правило                                  | Как соблюдается сейчас                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2.1 Source of Truth                      | Сущности PHASE 01 хранятся в PostgreSQL (PHASE 02); Telegram, чат AI и файлы не хранят бизнес-состояние.                                                                                                                                                                                                                                                     |
| 2.2 Event History                        | Событие на каждую версию каждой сущности в той же транзакции; БД не фиксирует изменение без события и не даёт изменить или удалить событие (PHASE 03, `@roi-dealer/events`, миграция `0002`).                                                                                                                                                                |
| 2.3 AI не меняет state                   | AI-кода нет. Пакеты `agents`, `judges`, `ai-runtime` — placeholders с зафиксированным правилом в README.                                                                                                                                                                                                                                                     |
| 2.4 AI providers заменяемы               | Провайдеры не подключены. Контракт `runTask(...)` закреплён за `@roi-dealer/ai-runtime` (PHASE 09).                                                                                                                                                                                                                                                          |
| 2.6 Ограниченные автоматизации           | Workflows отсутствуют. Graceful shutdown имеет timeout (10 s) — основа для будущих лимитов.                                                                                                                                                                                                                                                                  |
| 2.11 Security                            | `.env` в `.gitignore`; `.env.example` без секретов; ошибки конфигурации не содержат значений; logger редактирует чувствительные ключи; `/health` не раскрывает текст ошибок; PostgreSQL слушает только `127.0.0.1`; lifecycle-скрипты зависимостей заблокированы (`pnpm-workspace.yaml`); события — аудит изменений с актором и `correlation_id` (PHASE 03). |
| 2.12 No silent architecture changes      | Процесс ADR — [`docs/ADR/`](ADR/README.md); ADR-0001…0004 приняты владельцем.                                                                                                                                                                                                                                                                                |
| 2.13 Retrieval Before Reasoning          | Всё прочитанное из PostgreSQL (сущности и события) проверяется схемами до использования; итоги (расходы) считаются кодом по строкам БД.                                                                                                                                                                                                                      |
| 2.15 Feature Kill Gate                   | Применён к scope PHASE 00 — см. раздел «Scope decisions» в отчёте PHASE 00.                                                                                                                                                                                                                                                                                  |
| 2.19 Cheap Experiment, Strong Discipline | CI: typecheck, lint, format, unit + integration tests, build на каждый push / PR.                                                                                                                                                                                                                                                                            |
| 2.20 Abstract the pattern                | Требования к Media Factory: rights gate, `MotionSpec`, отдельные права на аудио — [план PHASE 19](phases/19_media_factory.plan.md). Кода пока нет.                                                                                                                                                                                                           |
| 2.21 Permitted access only               | Telegram — только официальный Bot API; источники данных (PHASE 05) и медиа-провайдеры (PHASE 19) — только официальные API и разрешённые тарифы.                                                                                                                                                                                                              |
