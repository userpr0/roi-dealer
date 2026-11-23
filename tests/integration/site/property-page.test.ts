import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@roi-dealer/database';
import {
  AUTOMATION_CONTROL_ID,
  createProperty,
  pauseSystem,
  propertyIdSchema,
  resumeSystem,
  setPropertyStatus,
  toTimestamp,
  type Property,
} from '@roi-dealer/domain';
import { createHealthRegistry } from '@roi-dealer/observability';
import { uuidv7 } from '@roi-dealer/shared';
import {
  createPropertyViewCounter,
  createSiteTracker,
  createSubmissionLimiter,
  privacyPage,
  propertyPage,
  propertyPhoto,
  propertyPrivacyPage,
  SITE_TRACKER,
} from '@roi-dealer/site';
import { createRouter } from '../../../apps/api/src/router.js';
import { startApiServer, type ApiServer } from '../../../apps/api/src/server.js';
import {
  createTestDatabase,
  registerPrincipal,
  type TestDatabase,
} from '../../support/database.js';
import { OWNER } from '../../support/domain.js';
import { createCapturingLogger } from '../../support/logger.js';

let test: TestDatabase;
let db: Database;
let server: ApiServer;
let api: string;
let shop: Property;
const { logger, records } = createCapturingLogger('api');
const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1';
const CONTACT = 'privacy@example.test';
const now = () => toTimestamp(new Date());

const visit = (path: string, init: RequestInit = {}) =>
  fetch(`${api}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { 'user-agent': BROWSER, ...init.headers },
  });

const post = (path: string, fields: Record<string, string>) =>
  visit(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });

const funnel = () =>
  db.sql<{ step: string; channel: string; material: string | null }[]>`
    select step, channel, material from property_funnel order by id
  `;

async function setKillSwitch(paused: boolean): Promise<void> {
  const control = await db.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
  if (control === undefined) throw new Error('no kill switch');
  await db.repositories.systemControls.update(
    paused
      ? pauseSystem(control, 'Тест', { actor: OWNER, at: now() })
      : resumeSystem(control, { actor: OWNER, at: now() }),
    OWNER,
  );
}

async function setStatus(status: Property['status']): Promise<void> {
  shop = setPropertyStatus(shop, status, { actor: OWNER, at: now() });
  await db.repositories.properties.update(shop, OWNER);
}

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  await registerPrincipal(db, SITE_TRACKER);
  shop = createProperty(
    {
      slug: 'tetiiv-orenda-3f9a',
      title: 'Тетіїв, Соборна, 42 м², оренда <b>',
      kind: 'commercial',
      deal: 'rent',
      region: 'Київська',
      settlement: 'Тетіїв',
      street: 'Соборна',
      areaM2: 42,
      priceCents: 25_000,
      negotiable: true,
      rentTerms: 'Від 11 місяців.\nДепозит — один місяць.',
      cons: 'Вхід зі двору.',
    },
    { id: propertyIdSchema.parse(uuidv7()), actor: OWNER, at: now() },
  );
  await db.repositories.properties.insert(shop);
  await db.properties.addPhoto(
    shop.id,
    { content: new Uint8Array(2_000).fill(9), width: 1280, height: 960 },
    OWNER,
  );

  // No cache of the kill switch and the access, so the test sees every change at once.
  const tracker = createSiteTracker({ database: db, logger, stateTtlMs: 0 });
  const deps = {
    database: db,
    tracker,
    views: createPropertyViewCounter({ database: db, tracker, logger }),
    logger,
    contactEmail: CONTACT,
    limiter: createSubmissionLimiter(),
  };
  server = await startApiServer({
    host: '127.0.0.1',
    port: 0,
    router: createRouter({
      health: createHealthRegistry({ service: 'api' }),
      site: {
        preview: () => Promise.resolve({ status: 404 }),
        landing: () => Promise.resolve({ status: 404 }),
        privacy: () => privacyPage(undefined),
        property: (slug, step, request, form) => propertyPage(deps, slug, step, request, form),
        propertyPhoto: (slug, position) => propertyPhoto(deps, slug, position),
        propertyPrivacy: () => propertyPrivacyPage(CONTACT),
      },
    }),
    logger,
  });
  api = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(async () => {
  await server.close();
  await test.drop();
});

describe('the page of an own object (phase 36, ADR-0016 §10–12)', () => {
  it('does not exist while the object is a draft', async () => {
    expect((await visit(`/o/${shop.slug}`)).status).toBe(404);
    expect((await visit(`/o/${shop.slug}/photo/1.jpg`)).status).toBe(404);
  });

  it('shows a listed object in Ukrainian, escaped, with microdata and no scripts', async () => {
    await setStatus('listed');
    const response = await visit(`/o/${shop.slug}?c=olx&m=TET01-OBH-01`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain('<html lang="uk">');
    expect(html).toContain('Тетіїв, Соборна, 42 м², оренда &lt;b&gt;');
    expect(html).not.toContain('<b>');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('itemtype="https://schema.org/Offer"');
    expect(html).toContain('itemtype="https://schema.org/Place"');
    expect(html).toContain('<span itemprop="addressLocality">Тетіїв</span>');
    expect(html).toContain('<span itemprop="price" content="250.00">$250 / міс., торг</span>');
    expect(html).toContain(
      '<h2>Умови оренди</h2>\n<p>Від 11 місяців.</p>\n<p>Депозит — один місяць.</p>',
    );
    expect(html).toContain(`src="/o/${shop.slug}/photo/1.jpg"`);
    // The form carries the tags of the address.
    expect(html).toContain('<input type="hidden" name="c" value="olx">');
    expect(html).toContain('<input type="hidden" name="m" value="tet01-obh-01">');
    expect(html).toContain('<a href="/o/privacy">Конфіденційність</a>');
  });

  it('counts a person’s view once and never a robot’s', async () => {
    await visit(`/o/${shop.slug}?c=olx`);
    await visit(`/o/${shop.slug}?c=olx`, { headers: { 'user-agent': 'Googlebot/2.1' } });
    expect(await funnel()).toEqual([{ step: 'view', channel: 'olx', material: 'tet01-obh-01' }]);
  });

  it('serves the photos of the page', async () => {
    const photo = await visit(`/o/${shop.slug}/photo/1.jpg`);
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await photo.arrayBuffer())).toHaveLength(2_000);
    expect((await visit(`/o/${shop.slug}/photo/2.jpg`)).status).toBe(404);
  });

  it('takes a lead with a phone: the funnel and the phone in one transaction, once a day', async () => {
    const lead = {
      phone: '067 123 45 67',
      name: 'Олена',
      way: 'viber',
      consent: 'yes',
      website: '',
      c: 'olx',
      m: 'tet01-obh-01',
    };
    const response = await post(`/o/${shop.slug}/lead`, lead);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/o/${shop.slug}/thanks`);
    const thanks = await (await visit(`/o/${shop.slug}/thanks`)).text();
    expect(thanks).toContain('Власник зв’яжеться з вами');
    const [contact] = await db.sql<{ phone: string; name: string; preferred: string }[]>`
      select phone, name, preferred from property_contacts
    `;
    expect(contact).toEqual({ phone: '+380671234567', name: 'Олена', preferred: 'viber' });
    // The same phone again the same day is not a new lead.
    expect(
      (await post(`/o/${shop.slug}/lead`, { ...lead, phone: '+380 67 123-45-67' })).status,
    ).toBe(303);
    expect((await funnel()).filter((row) => row.step === 'lead')).toEqual([
      { step: 'lead', channel: 'olx', material: 'tet01-obh-01' },
    ]);
    // Nothing of the form reaches the logs.
    expect(JSON.stringify(records)).not.toContain('123');
    expect(JSON.stringify(records)).not.toContain('Олена');
  });

  it('asks again for a wrong phone or a missing consent and stores nothing from a robot', async () => {
    const wrong = await post(`/o/${shop.slug}/lead`, { phone: '12', consent: 'yes', c: 'tg' });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('Вкажіть номер телефону');
    const noConsent = await post(`/o/${shop.slug}/lead`, { phone: '0501112233', c: 'tg' });
    expect(noConsent.status).toBe(400);
    const robot = await post(`/o/${shop.slug}/lead`, {
      phone: '0501112233',
      consent: 'yes',
      website: 'http://spam.example',
    });
    expect(robot.status).toBe(303);
    expect(await db.sql`select 1 from property_contacts`).toHaveLength(1);
  });

  it('stops taking leads while the kill switch is on', async () => {
    await setKillSwitch(true);
    const paused = await post(`/o/${shop.slug}/lead`, { phone: '0501112233', consent: 'yes' });
    expect(paused.status).toBe(503);
    await setKillSwitch(false);
    expect(await db.sql`select 1 from property_contacts`).toHaveLength(1);
  });

  it('is gone with its photos once the object is closed', async () => {
    await setStatus('closed');
    expect((await visit(`/o/${shop.slug}`)).status).toBe(410);
    expect((await visit(`/o/${shop.slug}/photo/1.jpg`)).status).toBe(410);
    expect(
      (await post(`/o/${shop.slug}/lead`, { phone: '0501112233', consent: 'yes' })).status,
    ).toBe(410);
  });

  it('has a Ukrainian privacy notice with the contact for deletion', async () => {
    const response = await visit('/o/privacy');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Конфіденційність');
    expect(html).toContain(CONTACT);
    expect(html).toContain('180 днів');
  });
});
