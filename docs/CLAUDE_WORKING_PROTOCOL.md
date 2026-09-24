# Claude Code — Working Protocol

> **Источник:** Implementation Playbook v1.1 — §6, §9, §10 (перенесено дословно), плюс практические правила этого repository.

## Перед началом Phase

Claude обязан:

1. прочитать `CLAUDE_CONSTITUTION.md`, `SYSTEM_ARCHITECTURE.md`, `TECH_STACK.md`, `CLAUDE_WORKING_PROTOCOL.md`, `CURRENT_STATE.md` и файл текущего Phase;
2. проанализировать repository;
3. не предполагать, что файл или компонент существует;
4. проверить tests, migrations, dependencies, build и git status;
5. сначала написать краткий execution plan.

## Во время Phase

Claude обязан:

1. работать небольшими логическими блоками;
2. после критических изменений запускать tests;
3. не отключать failing tests ради зелёного результата;
4. не скрывать errors;
5. не добавлять ненужные зависимости;
6. не делать рефакторинг вне задачи без необходимости;
7. не переходить к следующему Phase;
8. не добавлять реальные секреты;
9. не выполнять опасные операции без approval;
10. сохранять архитектурную совместимость;
11. применять Feature Kill Gate к необязательному scope;
12. не строить будущие функции «на всякий случай»;
13. для authoritative data paths применять Retrieval Before Reasoning;
14. отмечать, какую бизнес-гипотезу или обязательную инфраструктурную потребность обслуживает новая функциональность.

## После Phase

Claude создаёт Phase Report:

```text
PHASE REPORT

Phase:
Status: PASS / PARTIAL / FAILED

Implemented:
- ...

Files created:
- ...

Files modified:
- ...

Database migrations:
- ...

Tests added:
- ...

Test results:
- ...

Security implications:
- ...

Cost implications:
- ...

Known limitations:
- ...

Technical debt:
- ...

Architecture deviations:
- NONE / list

Scope decisions:
- implemented because ...
- deferred because ...

Business hypothesis enabled by this phase:
- ...

Authoritative data paths verified:
- ...

Ready for next phase:
YES / NO
```

После отчёта обновить `docs/CURRENT_STATE.md` и остановиться.

## 9. Что владелец проверяет после PHASE 00

1. Claude сообщил `PASS`, а не скрытый `PARTIAL`.
2. Tests действительно запускались.
3. Нет failing tests.
4. `/health` работает.
5. Mini App запускается.
6. PostgreSQL поднимается локально.
7. В repository нет API keys.
8. `CURRENT_STATE.md` создан.
9. Claude не начал PHASE 01.
10. Все architecture files существуют.

Если что-то не выполнено, PHASE 00 не считается завершённым.

---

## 10. Как продолжать после PHASE 00

```text
Owner approves Phase 00
↓
Claude receives PHASE 01 only
↓
Claude implements Core Domain
↓
Tests
↓
Phase Report
↓
STOP
↓
Owner review
↓
PHASE 02
```

Это правило сохраняется для всех Phase.

---

## Практика в этом repository

### Обязательный порядок чтения в начале сессии

1. `docs/CURRENT_STATE.md` — текущая Phase, её статус и что разрешено дальше.
2. `docs/CLAUDE_CONSTITUTION.md`, `docs/SYSTEM_ARCHITECTURE.md`, `docs/TECH_STACK.md`, этот файл.
3. Файл текущей Phase в `docs/phases/`.
4. `docs/ADR/` — принятые и предложенные решения.

### Проверки перед Phase Report

Все команды выполняются из корня repository и должны завершиться успешно:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test            # unit + integration
pnpm build
pnpm infra:up        # PostgreSQL healthy
```

Результаты вставляются в Phase Report как есть. Failing tests не отключаются и не скрываются.

### Правила кода

- **Логирование** — только через `createLogger` из `@roi-dealer/observability`. `console.*` запрещён ESLint-правилом `no-console`.
- **Конфигурация** — только через `loadConfig(schema, process.env)` из `@roi-dealer/shared` со схемой Zod. Значения конфигурации не логируются.
- **Внешние данные** (HTTP, AI output, интеграции) валидируются схемой до использования.
- **Процессы** регистрируют освобождение ресурсов в `ShutdownManager` (`shutdown.register(name, hook)`).
- **Health checks** новых зависимостей (database, temporal, storage, AI providers) добавляются через `HealthRegistry.register(...)` — контракт `GET /health` не меняется.
- **Бизнес-логика** не пишется в `apps/*`: apps — тонкий транспортный слой над packages.

### Добавление нового workspace package

1. `packages/<name>/package.json` — `"type": "module"`, `exports` с условием `@roi-dealer/source` → `./src/index.ts`, `types` → `./dist/index.d.ts`, `default` → `./dist/index.js`.
2. `packages/<name>/tsconfig.json` — `extends: ../../tsconfig.base.json`, `rootDir: src`, `outDir: dist`, `references` на используемые пакеты.
3. Ссылка в корневом `tsconfig.json` (`references`).
4. Зависимость объявляется явно (`"@roi-dealer/<name>": "workspace:*"`) в каждом потребителе, включая корневой `package.json`, если пакет импортируют тесты.
5. `README.md` с назначением и Phase.

### Git

- Небольшие логические коммиты с понятными сообщениями.
- Никогда не коммитить `.env`, ключи, токены, дампы БД.
- Lockfile (`pnpm-lock.yaml`) коммитится; CI устанавливает зависимости с `--frozen-lockfile`.
