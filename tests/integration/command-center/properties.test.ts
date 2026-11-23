import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capturePropertyLead, purgeExpiredContacts } from '@roi-dealer/crm';
import {
  createCommandCenter,
  createDecisionCardNotifier,
  type CommandCenter,
} from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import { toTimestamp, type Actor } from '@roi-dealer/domain';
import type { InlineKeyboard } from '@roi-dealer/telegram';
import {
  createTestDatabase,
  registerPrincipal,
  type TestDatabase,
} from '../../support/database.js';
import { createCapturingLogger } from '../../support/logger.js';
import { ownerRouter, ROUTER_OWNER_ID } from '../../support/owner-router.js';

let test: TestDatabase;
let db: Database;
let center: CommandCenter;
const { logger, records } = createCapturingLogger('bot');
const SITE: Actor = { type: 'integration', id: 'site' };
const now = () => toTimestamp(new Date());

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
  await registerPrincipal(db, SITE);
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
    expect(card.map((data) => data.split(':').slice(0, 2).join(':'))).toEqual([
      'pr:s',
      'pr:s',
      'pr:p',
    ]);
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
    expect(
      chat
        .buttons()
        .filter((data) => data.startsWith('pr:s:'))
        .map((data) => data.at(-1)),
    ).toEqual(['u', 'c', 'w']);

    // Every version has its event from the owner.
    const events = await db.sql<{ type: string; actor_type: string }[]>`
      select type, actor_type from events where aggregate_type = 'property' order by position
    `;
    expect(events).toEqual([
      { type: 'property.created', actor_type: 'owner' },
      { type: 'property.updated', actor_type: 'owner' },
    ]);
  });

  it("takes the photos of an object after «📷 Фото», in Telegram's ready size", async () => {
    const chat = ownerRouter({
      logger,
      commands: center.commands,
      callbacks: center.callbacks,
      photo: center.photo,
    });
    const jpeg = (size: number) => {
      const bytes = new Uint8Array(size).fill(1);
      bytes.set([0xff, 0xd8, 0xff]);
      return bytes;
    };
    // Without «📷 Фото» first the bot explains how.
    await chat.sendPhoto([
      { file_id: 'p0', width: 1280, height: 960, file_size: 3_000, bytes: jpeg(3_000) },
    ]);
    expect(chat.last()?.text).toContain('нажмите «📷 Фото»');

    await chat.send('/properties');
    await chat.press(chat.buttons().find((data) => data.startsWith('pr:p:')) ?? '');
    expect(chat.last()?.text).toContain('📷 Пришлите фото «Тетіїв, Соборна, 42 м², оренда»');
    // Telegram sends 320, 800 and 1280 px and the original 2560 px: the 1280 px one is kept.
    await chat.sendPhoto([
      { file_id: 's', width: 320, height: 240, file_size: 1_000, bytes: jpeg(1_000) },
      { file_id: 'm', width: 800, height: 600, file_size: 2_000, bytes: jpeg(2_000) },
      { file_id: 'x', width: 1280, height: 960, file_size: 3_000, bytes: jpeg(3_000) },
      { file_id: 'y', width: 2560, height: 1920, file_size: 900_000, bytes: jpeg(4_000) },
    ]);
    expect(chat.last()?.text).toBe('📷 Фото 1/15 добавлено к «Тетіїв, Соборна, 42 м², оренда».');
    const [shop] = await db.repositories.properties.listByStatuses(['listed']);
    expect(await db.properties.photos(shop?.id ?? ('' as never))).toEqual([
      { position: 1, width: 1280, height: 960 },
    ]);
    // A file that is not a JPEG is refused.
    await chat.sendPhoto([
      { file_id: 'png', width: 800, height: 600, bytes: new Uint8Array(500).fill(2) },
    ]);
    expect(chat.last()?.text).toContain('Это не JPEG');

    // «🗑 Удалить все фото» asks first.
    await chat.press(`pr:x:${shop?.id ?? ''}`);
    await chat.press(chat.buttons().find((data) => data.startsWith('pr:y:')) ?? '');
    expect(chat.last()?.text).toBe('🗑 Удалено фото: 1. Новые — кнопкой «📷 Фото» в /properties.');
  });

  it('shows the object in the library next to what the system filed', async () => {
    const chat = ownerRouter({ logger, commands: center.commands, callbacks: center.callbacks });
    await chat.send('/library');
    expect(chat.last()?.text).toContain('📁 Недвижимость — тем 1, разложено 1');
  });
});

describe('leads of an object page in the bot (phase 36, ADR-0016 §12)', () => {
  const sent: { text: string; keyboard?: InlineKeyboard | undefined }[] = [];
  const notifier = () =>
    createDecisionCardNotifier({
      database: db,
      logger,
      deliver: (text, keyboard) => {
        sent.push({ text, keyboard });
        return Promise.resolve();
      },
    });
  let leadId: number;

  it('tells the owner about a lead once, without the phone', async () => {
    const [shop] = await db.repositories.properties.listByStatuses(['listed']);
    if (shop === undefined) throw new Error('no listed object');
    await capturePropertyLead(
      db,
      {
        propertyId: shop.id,
        phone: '+380671234567',
        name: 'Олена',
        way: 'viber',
        channel: 'olx',
        material: 'tet01-obh-01',
        at: now(),
      },
      SITE,
    );
    await notifier().runOnce();
    await notifier().runOnce();
    expect(sent).toHaveLength(1);
    const [notice] = sent;
    expect(notice?.text).toContain('📥 Заявка на «Тетіїв, Соборна, 42 м², оренда»');
    expect(notice?.text).toContain('Канал: OLX · материал tet01-obh-01 · удобно: Viber');
    expect(notice?.text).not.toContain('123');
    const buttons = (notice?.keyboard ?? []).flat().map((button) => button.callback_data);
    expect(buttons[0]).toMatch(/^pr:c:\d+$/);
    leadId = Number(buttons[0]?.split(':')[2]);
    expect(buttons.slice(1)).toEqual([
      `pr:f:${String(leadId)}:c`,
      `pr:f:${String(leadId)}:s`,
      `pr:f:${String(leadId)}:d`,
    ]);
  });

  it('shows the phone only on the owner’s press and never logs it', async () => {
    const chat = ownerRouter({ logger, commands: center.commands, callbacks: center.callbacks });
    await chat.press(`pr:c:${String(leadId)}`);
    expect(chat.last()?.text).toBe('📱 +380671234567 · Олена · удобно: Viber');
    expect(JSON.stringify(records)).not.toContain('380671234567');
  });

  it('records a showing after the lead with confirmation, with its channel and material', async () => {
    const chat = ownerRouter({ logger, commands: center.commands, callbacks: center.callbacks });
    await chat.press(`pr:f:${String(leadId)}:s`);
    expect(chat.last()?.text).toContain(
      'Записать показ: «Тетіїв, Соборна, 42 м², оренда» · OLX · материал tet01-obh-01?',
    );
    await chat.press(chat.buttons().find((data) => data.startsWith('pr:y:')) ?? '');
    expect(chat.last()?.text).toBe('✅ Записано. Цифры объекта — /properties.');
    const [showing] = await db.sql<
      { step: string; channel: string; material: string; lead_id: string }[]
    >`
      select step, channel, material, lead_id::text as lead_id from property_funnel where step = 'showing'
    `;
    expect(showing).toEqual({
      step: 'showing',
      channel: 'olx',
      material: 'tet01-obh-01',
      lead_id: String(leadId),
    });

    await chat.send('/properties');
    expect(chat.last()?.text).toContain('👁 0 · 📥 1 · 📞 0 · 👀 1 · 🤝 0 · заявки: OLX 1');
  });

  it('deletes a phone on the person’s request with /forget', async () => {
    const [shop] = await db.repositories.properties.listByStatuses(['listed']);
    if (shop === undefined) throw new Error('no listed object');
    await capturePropertyLead(
      db,
      { propertyId: shop.id, phone: '+380501112233', way: 'call', channel: 'tg', at: now() },
      SITE,
    );
    const chat = ownerRouter({ logger, commands: center.commands, callbacks: center.callbacks });
    await chat.send('/forget 050 111 22 33');
    expect(chat.last()?.text).toContain('❓ Удалить +380501112233 из заявок: 1?');
    await chat.press(chat.buttons().find((data) => data.startsWith('fg:y:')) ?? '');
    expect(chat.last()?.text).toBe('🗑 Удалено: телефон из заявок — 1.');
    expect(
      await db.sql`select 1 from property_contacts where phone = '+380501112233'`,
    ).toHaveLength(0);
  });

  it('deletes the phones of a closed object and those past 180 days', async () => {
    const chat = ownerRouter({ logger, commands: center.commands, callbacks: center.callbacks });
    await chat.send('/properties');
    await chat.press(chat.buttons().find((data) => data.endsWith(':c')) ?? '');
    expect(chat.last()?.text).toContain('телефоны заявок удалятся');
    await chat.press(chat.buttons().find((data) => data.startsWith('pr:y:')) ?? '');
    expect(chat.last()?.text).toContain('Телефонов заявок удалено: 1.');
    expect(await db.sql`select 1 from property_contacts`).toHaveLength(0);
    // The lead stays in the numbers; its notice no longer offers the phone.
    await chat.press(`pr:c:${String(leadId)}`);
    expect(chat.last()?.text).not.toContain('+380');

    // The retention period removes what is older than 180 days, as the system.
    const [another] = await db.repositories.properties.listByStatuses(['closed']);
    expect(another).toBeDefined();
    await expect(
      purgeExpiredContacts({
        database: db,
        logger,
        now: () => Date.now() + 181 * 86_400_000,
      }),
    ).resolves.toEqual({ erased: 0 });
  });
});
