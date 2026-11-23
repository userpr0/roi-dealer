import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCommandCenter, type CommandCenter } from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import { createTestDatabase, type TestDatabase } from '../../support/database.js';
import { createCapturingLogger } from '../../support/logger.js';
import { ownerRouter, ROUTER_OWNER_ID } from '../../support/owner-router.js';

let test: TestDatabase;
let db: Database;
let center: CommandCenter;
const { logger } = createCapturingLogger('bot');

const FORM = [
  '/property',
  'Название: Тетіїв, Соборна, 42 м², оренда',
  'Тип: коммерция',
  'Сделка: аренда',
  'Область: Київська',
  'Населённый пункт: Тетіїв',
  'Улица: Соборна',
  'Площадь: 42',
  'Цена: 250',
  'Торг: нет',
].join('\n');

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  center = createCommandCenter({ database: db, logger, deliverDigest: () => Promise.resolve() });
});

afterAll(async () => {
  await center.stopDigest();
  await test.drop();
});

describe('own objects through the bot (phase 36)', () => {
  it('sends the form, then saves a filled one as a draft in the library after confirmation', async () => {
    const chat = ownerRouter({ logger, commands: center.commands, callbacks: center.callbacks });
    await chat.send('/property');
    expect(chat.last()?.text).toContain('Название: Тетиев, Соборна, 42 м², аренда');

    await chat.send(FORM.replace('Площадь: 42', 'Площадь: много'));
    expect(chat.last()?.text).toContain('⛔ Не сохранено');
    expect(await db.repositories.properties.listByStatuses(['draft'])).toEqual([]);

    await chat.send(FORM);
    expect(chat.last()?.text).toContain('🏠 Тетіїв, Соборна, 42 м², оренда');
    expect(chat.last()?.text).toContain('Он ляжет в библиотеку: Недвижимость › Тетіїв.');
    const save = chat.buttons().find((data) => data.startsWith('pr:y:')) ?? '';
    await chat.press(save);
    expect(chat.last()?.text).toBe(
      [
        '💾 Сохранено как черновик: «Тетіїв, Соборна, 42 м², оренда».',
        'Библиотека: Недвижимость › Тетіїв › Тетіїв, Соборна, 42 м², оренда.',
        'Выставить в продажу — /properties.',
      ].join('\n'),
    );
    // A repeated press saves nothing twice.
    await chat.press(save);
    const [shop, ...others] = await db.repositories.properties.listByStatuses(['draft']);
    expect(others).toEqual([]);
    expect(shop).toMatchObject({
      status: 'draft',
      deal: 'rent',
      priceCents: 25_000,
      negotiable: false,
      createdBy: { type: 'owner', id: `telegram:${String(ROUTER_OWNER_ID)}` },
    });
    expect(shop?.slug).toMatch(/^tetiiv-orenda-[0-9a-f]{4}$/);
    expect(await db.library.topicOf('property', shop?.id ?? '')).toBeDefined();
  });

  it('lists an object with confirmation and refuses a stale card', async () => {
    const chat = ownerRouter({ logger, commands: center.commands, callbacks: center.callbacks });
    await chat.send('/properties');
    expect(chat.last()?.text).toContain(
      '1. Тетіїв, Соборна, 42 м², оренда — 📝 черновик · $250/мес',
    );
    const card = chat.buttons();
    expect(card.map((data) => data.split(':').slice(0, 2).join(':'))).toEqual(['pr:s', 'pr:s']);
    const list = card.find((data) => data.endsWith(':l')) ?? '';

    await chat.press(list);
    expect(chat.last()?.text).toBe(
      'Выставить в продажу: «Тетіїв, Соборна, 42 м², оренда»? Подтверждение действует 10 минут.',
    );
    await chat.press(chat.buttons().find((data) => data.startsWith('pr:y:')) ?? '');
    expect(chat.last()?.text).toBe(
      '📢 в продаже: «Тетіїв, Соборна, 42 м², оренда». Список — /properties.',
    );
    const [shop] = await db.repositories.properties.listByStatuses(['listed']);
    expect(shop).toMatchObject({ status: 'listed', version: 2 });

    // The old card carries version 1: it changes nothing.
    await chat.press(list);
    expect(chat.last()?.text).toBe('Карточка устарела. Повторите /properties.');
    await chat.send('/properties');
    expect(chat.buttons().map((data) => data.at(-1))).toEqual(['u', 'c', 'w']);

    // Every version has its event from the owner.
    const events = await db.sql<{ type: string; actor_type: string }[]>`
      select type, actor_type from events where aggregate_type = 'property' order by position
    `;
    expect(events).toEqual([
      { type: 'property.created', actor_type: 'owner' },
      { type: 'property.updated', actor_type: 'owner' },
    ]);
  });

  it('shows the object in the library next to what the system filed', async () => {
    const chat = ownerRouter({ logger, commands: center.commands, callbacks: center.callbacks });
    await chat.send('/library');
    expect(chat.last()?.text).toContain('📁 Недвижимость — тем 1, разложено 1');
  });
});
