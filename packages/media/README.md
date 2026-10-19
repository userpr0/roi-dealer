# @roi-dealer/media

**Статус:** реализован (PHASE 19a — Media Factory, минимум, [спецификация](../../docs/phases/19a_media_factory.md)).

Лендинг теста и три рекламных текста. Слова пишет AI-задача `write-landing`; код проверяет их, ставит цену и честную пометку и собирает статичную страницу. Сущность — `MediaAsset` в `@roi-dealer/domain`; агент — `landingWriterAgent` в `@roi-dealer/agents`; карточка владельца — в `@roi-dealer/command-center`; страницы на `api` — `@roi-dealer/site`.

## Проверка кодом (`checkLanding`, `toLandingContent`)

- длины и число частей: три выгоды, три шага, 2–4 вопроса, три рекламных текста;
- без выдуманных доказательств: отзывы, «trusted by», число клиентов, рейтинги, награды, гарантии, дефицит, «лучший / №1»;
- суммы денег и цифры результата — только те, что есть во входе;
- без ссылок, почты и телефонов; только английский.

Цена — из гипотезы (`priceLabel`), пометка — по способу проверки (`landingDisclosure`): `preorder` или `in_development`. Модель их не задаёт.

## Правила использования

- Вызов модели — только через `runTask` (`@roi-dealer/ai-runtime`); новая версия подсказки — новая `version` задачи с эталоном.
- Страница — только через `renderLanding`: без скриптов и внешних ресурсов, каждый текст экранирован, `noindex`.
- Тексты страниц и подсказки не логируются.

## Export surface

| Экспорт                                                         | Назначение                                         |
| --------------------------------------------------------------- | -------------------------------------------------- |
| `writeLandingTask`, `WriteLandingInput`, `WriteLandingOutput`   | AI-задача `write-landing` с эталоном из 20 случаев |
| `checkLanding`, `toLandingContent`, `landingSource`             | Проверка ответа и сборка содержимого               |
| `scoreWriteLanding`                                             | Оценка эталона                                     |
| `landingDisclosure`, `disclosureText`, `priceLabel`             | Пометка и цена — код                               |
| `renderLanding`, `escapeHtml`, `landingSlug`, `newPreviewToken` | Шаблон страницы, адрес, токен предпросмотра        |
| `MEDIA_TASKS`, `PACKAGE_NAME`                                   | Задачи пакета для evals worker; идентификатор      |
