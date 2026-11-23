import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@roi-dealer/database';
import {
  createProperty,
  propertyIdSchema,
  toTimestamp,
  type Actor,
  type Property,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import {
  createTestDatabase,
  registerPrincipal,
  type TestDatabase,
} from '../../support/database.js';
import { AGENT, OWNER, SYSTEM } from '../../support/domain.js';

const SITE: Actor = { type: 'integration', id: 'site' };
let test: TestDatabase;
let db: Database;
let shop: Property;
const now = () => toTimestamp(new Date());

beforeAll(async () => {
  test = await createTestDatabase();
  db = test.database;
  await registerPrincipal(db, SITE);
  shop = createProperty(
    {
      slug: 'tetiiv-orenda-3f9a',
      title: 'Тетіїв, Соборна, 42 м², оренда',
      kind: 'commercial',
      deal: 'rent',
      region: 'Київська',
      settlement: 'Тетіїв',
      areaM2: 42,
      priceCents: 25_000,
      negotiable: false,
    },
    { id: propertyIdSchema.parse(uuidv7()), actor: OWNER, at: now() },
  );
  await db.repositories.properties.insert(shop);
});

afterAll(async () => {
  await test.drop();
});

describe('photos of an object (phase 36)', () => {
  it('keeps at most 15 photos in their order, only from the owner', async () => {
    const jpeg = new Uint8Array(1_000).fill(7);
    await expect(
      db.properties.addPhoto(shop.id, { content: jpeg, width: 1280, height: 960 }, AGENT),
    ).rejects.toThrow('may not property.manage');
    for (let index = 1; index <= 15; index += 1) {
      expect(
        await db.properties.addPhoto(shop.id, { content: jpeg, width: 1280, height: 960 }, OWNER),
      ).toBe(index);
    }
    expect(
      await db.properties.addPhoto(shop.id, { content: jpeg, width: 1280, height: 960 }, OWNER),
    ).toBeUndefined();
    expect((await db.properties.photos(shop.id)).map((photo) => photo.position)).toHaveLength(15);
    expect(
      Buffer.from((await db.properties.photo(shop.id, 3)) ?? []).equals(Buffer.from(jpeg)),
    ).toBe(true);
    // A photo larger than Telegram's ready size or 400 KB is refused by the database too.
    await expect(
      db.sql`insert into property_photos (property_id, position, content, width, height)
             values (${shop.id}, 16, ${new Uint8Array(200)}, 2000, 900)`,
    ).rejects.toThrow();
    expect(await db.properties.removePhotos(shop.id, OWNER)).toBe(15);
    expect(await db.properties.photos(shop.id)).toEqual([]);
  });
});

describe('the funnel and the phones of leads (phase 36)', () => {
  let leadId: number;

  it('lets the page write views and leads and the owner the rest, and never changes a row', async () => {
    await db.properties.track({ propertyId: shop.id, step: 'view', channel: 'olx' }, SITE);
    leadId = await db.properties.track(
      { propertyId: shop.id, step: 'lead', channel: 'olx', material: 'tet01-obh-01' },
      SITE,
    );
    await db.properties.addContact(
      {
        leadId,
        propertyId: shop.id,
        phone: '+380671234567',
        preferred: 'viber',
        consentAt: now(),
      },
      SITE,
    );
    await db.properties.track(
      { propertyId: shop.id, step: 'call', channel: 'olx', material: 'tet01-obh-01', leadId },
      OWNER,
    );
    // The page may not record a deal; the owner may not record a view.
    await expect(
      db.properties.track({ propertyId: shop.id, step: 'deal', channel: 'olx' }, SITE),
    ).rejects.toThrow('may not property.manage');
    await expect(
      db.properties.track({ propertyId: shop.id, step: 'view', channel: 'olx' }, OWNER),
    ).rejects.toThrow();
    await expect(db.sql`update property_funnel set channel = 'fb'`).rejects.toThrow();
    await expect(db.sql`delete from property_funnel`).rejects.toThrow();

    expect(await db.properties.counts([shop.id])).toEqual([
      { propertyId: shop.id, step: 'call', channel: 'olx', material: 'tet01-obh-01', count: 1 },
      { propertyId: shop.id, step: 'lead', channel: 'olx', material: 'tet01-obh-01', count: 1 },
      { propertyId: shop.id, step: 'view', channel: 'olx', count: 1 },
    ]);
    expect(await db.properties.pendingNotices()).toEqual([
      expect.objectContaining({ id: leadId, channel: 'olx', preferred: 'viber' }),
    ]);
  });

  it('shows a phone only to the owner and deletes it for real', async () => {
    await expect(db.properties.contact(leadId, SITE)).rejects.toThrow('may not property.manage');
    expect(await db.properties.contact(leadId, OWNER)).toMatchObject({
      phone: '+380671234567',
      preferred: 'viber',
    });
    expect(
      await db.properties.hasRecentContact(
        shop.id,
        '+380671234567',
        toTimestamp(new Date(0)),
        SITE,
      ),
    ).toBe(true);
    // A person's request, then the object closes: nothing is left either way.
    expect(await db.properties.forgetPhone('+380671234567', OWNER)).toBe(1);
    expect(await db.properties.contact(leadId, OWNER)).toBeUndefined();
    expect(await db.properties.eraseContacts(shop.id, OWNER)).toBe(0);
    // The lead itself stays in the funnel, without the phone.
    expect(await db.properties.lead(leadId)).toEqual(
      expect.objectContaining({ id: leadId, channel: 'olx', material: 'tet01-obh-01' }),
    );
    expect((await db.properties.lead(leadId))?.preferred).toBeUndefined();
  });

  it('deletes phones after the retention period as the system', async () => {
    const second = await db.properties.track(
      { propertyId: shop.id, step: 'lead', channel: 'tg' },
      SITE,
    );
    await db.properties.addContact(
      {
        leadId: second,
        propertyId: shop.id,
        phone: '+380501112233',
        preferred: 'call',
        consentAt: now(),
      },
      SITE,
    );
    const later = toTimestamp(new Date(Date.now() + 60_000));
    expect(await db.properties.purgeContacts(later, { type: 'system', id: 'lead-retention' })).toBe(
      1,
    );
    expect(await db.sql`select 1 from property_contacts`).toHaveLength(0);
    await expect(db.properties.purgeContacts(later, SYSTEM)).resolves.toBe(0);
  });
});
