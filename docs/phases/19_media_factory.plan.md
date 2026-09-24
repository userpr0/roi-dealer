# PHASE 19 — Media Factory: требования и план

> **Статус:** backlog требований владельца (D-012, 2026-09-24). Реализация — в PHASE 19 после approval владельца; до этого кода нет.
> **Принципы:** конституция §2.20 «паттерн, а не копия» и §2.21 «только разрешённый доступ» ([ADR-0004](../ADR/0004-constitution-pattern-and-permitted-access.md)).

## Цель

Media Factory производит креативы для гипотез и экспериментов (лендинги, демо, короткие видео, рекламу) по схеме Creative Brief → Brand Kit → Persona → Media Jobs → Preview → QA. Этот документ фиксирует требования к классу задач **Motion Reference / Motion Transfer**. В них новый оригинальный ролик создаётся по параметрам движения, ракурса и темпа из разрешённого референса, а не генерируется с нуля.

## Ключевые решения

1. **Не привязываться к провайдеру.** Каноническое представление — внутренний `MotionSpec`, а не промпт под конкретный сервис. Один `MotionSpec` передаётся разным генераторам через Provider Router.
2. **Provider Capability Registry.** Для каждого провайдера и модели хранится, что они умеют: video-to-video, motion reference, звук, длительность, разрешение, прозрачный фон, сохранение идентичности, ограничения входов, цена, задержка, известные сбои. Несовместимый режим отсекается до запуска, а не обнаруживается после оплаты.
3. **Preflight до рендера.** Права, входные файлы, длительность, разрешение, режим звука, совместимость с провайдером, бюджет, timeout, лимит повторов и fallback проверяются до отправки задачи.
4. **Temporal Media QA.** Проверяется не только то, что файл существует, но и стабильность во времени: лицо, персонаж, руки, волосы, одежда, геометрия тела, фон, объекты, синхронизация звука. Пороги зависят от Quality Tier.
5. **Права на аудио отдельно от видео.** Есть подтверждённое право — можно использовать. Нет — лицензированный или разрешённый звук либо новый.
6. **Главная метрика — Cost per Approved Asset:** полная стоимость (рендеры, повторы, API, время проверки), делённая на число одобренных результатов.
7. **Обучение.** После каждой задачи сохраняется `Task × Provider × Model × Format × Quality × Cost × Latency × Failure Reason`; история улучшает маршрутизацию.
8. **Вне архитектуры:** мультиаккаунты, антидетект и обход бесплатных лимитов (§2.21).

```text
Reference Asset
      ↓
Rights Check
      ↓
Motion Analysis
      ↓
MotionSpec
 ├─ camera movement
 ├─ body movement
 ├─ facial dynamics
 ├─ timing
 ├─ scene structure
 └─ framing
      ↓
Provider Router
      ↓
Generation
      ↓
Media QA
      ↓
Approved Asset
```

## Протокол (текст владельца, для следующей версии Playbook)

```text
MEDIA MOTION REFERENCE PROTOCOL

Purpose:
Support motion-reference and video-to-video generation without coupling
ROI Dealer to one provider or copying protected source material.

1. RIGHTS GATE
Before analyzing or using a reference asset, verify:
- ownership / license / permitted use;
- commercial-use rights where required;
- audio rights separately from video rights;
- platform restrictions.

If rights cannot be established:
STOP or use the asset only for abstract pattern research where lawful.
Do not publish copied footage/audio.

2. REFERENCE ANALYSIS
Convert an allowed reference into an internal MotionSpec.

MotionSpec should support:
- camera movement;
- framing;
- subject position;
- body movement;
- facial movement;
- timing;
- scene transitions;
- pacing;
- motion intensity;
- safe zones.

Do not make provider-specific prompts the canonical representation.

3. PROVIDER CAPABILITY CHECK
Before creating a paid render job, verify:
- supports image-to-video;
- supports video-to-video;
- supports motion reference;
- supported duration;
- supported resolution;
- audio capability;
- input restrictions;
- estimated cost;
- expected latency;
- known failure modes.

4. PREFLIGHT
Validate:
- input files;
- rights;
- duration;
- resolution;
- audio mode;
- provider compatibility;
- budget;
- timeout;
- retry allowance;
- fallback provider.

Do not send the render job if preflight fails.

5. JOB STATE MACHINE

DRAFT
→ PREFLIGHT
→ READY
→ SUBMITTED
→ RENDERING
→ TECHNICAL_QA
→ CREATIVE_QA
→ APPROVED

Alternative states:
FAILED
REJECTED
RETRY_REQUIRED
CANCELLED

6. RENDER QA
Check:
- file validity;
- duration;
- resolution;
- identity consistency;
- face consistency;
- body geometry;
- hands;
- hair;
- clothing;
- object continuity;
- background continuity;
- camera-motion consistency;
- temporal artifacts;
- audio/video sync;
- unwanted text/logos.

7. QUALITY TIERS
Support:
DRAFT
TEST
PRODUCTION
PREMIUM

Acceptance thresholds may differ by tier.

8. FALLBACK ROUTING
If Provider A fails:
- classify the failure;
- do not blindly retry;
- determine whether prompt/input/provider is responsible;
- retry only within budget;
- route to Provider B when compatible.

9. ECONOMICS
Record:
- render cost;
- retry cost;
- total compute/API cost;
- human review time;
- accepted/rejected status.

Primary metric:
Cost per Approved Asset.

10. LEARNING
After each job store:
Task × Provider × Model × Format × Quality × Cost × Latency × Failure Reason.

Use this history to improve future Provider Routing.
```

## Будущие сущности

| Сущность                  | Назначение                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReferenceAsset`          | Внешний материал-референс: источник, тип, хранение, связь с правами                                                                                            |
| `ReferenceRights`         | Права на референс: владелец / лицензия / разрешённое использование, коммерческое использование, ограничения платформы, доказательство (ссылка, снимок условий) |
| `MotionSpec`              | Каноническая спецификация движения: камера, кадрирование, позиция и движение тела, мимика, тайминг, переходы, темп, интенсивность, safe zones                  |
| `MediaProviderCapability` | Профиль провайдера и модели: режимы, длительности, разрешения, звук, ограничения входов, цена, задержка, известные сбои                                        |
| `RenderProfile`           | Параметры результата: формат, разрешение, длительность, режим звука, Quality Tier                                                                              |
| `MediaJob`                | Задача генерации с жизненным циклом из протокола, бюджетом, timeout, лимитом повторов и fallback                                                               |
| `MediaJobAttempt`         | Одна попытка у одного провайдера: стоимость, задержка, результат, классифицированная причина сбоя                                                              |
| `MediaQAResult`           | Результат технического и творческого QA по чек-листу и порогам Quality Tier                                                                                    |
| `AudioAsset`              | Звук: сгенерированный, лицензированный или собственный                                                                                                         |
| `AudioRights`             | Права на звук, отдельно от прав на видео                                                                                                                       |

## Заметки Claude по реализации

1. **Стыковка с готовым доменом (PHASE 01).**
   - Каждая `MediaJobAttempt` записывает расход через `CostEntry` категории `media`.
   - Preflight включает human gate: рендер дороже $20 требует одобрения (D-006).
   - Лимиты задачи (max cost, timeout, retries, fallback) выполняют §2.6.
   - Знания о провайдерах сохраняются как `KnowledgeAsset` видов `pattern` / `failure_pattern`, то есть в Company Brain.
   - Одобренный ролик — артефакт гипотезы или эксперимента (`Hypothesis.creative`, `Experiment.artifact`).
2. **Минимум сначала (§2.15).** PHASE 19 разумно разделить:
   - **19a:** Creative Brief, RenderProfile, MediaJob с preflight и fallback, реестр возможностей, автоматический технический QA (валидность файла, длительность, разрешение, наличие и синхронизация звука), творческий QA человеком через кнопку в пульте, Cost per Approved Asset.
   - **19b:** Motion Reference (`ReferenceAsset`, `ReferenceRights`, `MotionSpec`, анализ референса) и автоматический Temporal QA (лицо, руки, волосы, фон) — когда объём генераций окупит модели проверки.
3. **Тот же паттерн для AI Runtime (PHASE 09).** Model Router для LLM стоит строить на той же идее: реестр возможностей моделей, preflight (бюджет, лимиты, формат ответа), классификация сбоев, fallback и история `задача × модель × стоимость × качество`.
4. **Хранение референсов.** Материалы без подтверждённых прав не хранятся дольше, чем нужно для законного анализа, и никогда не публикуются (§2.20).
