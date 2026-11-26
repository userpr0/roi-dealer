import { describe, expect, it } from 'vitest';
import {
  createProperty,
  DomainError,
  hasContactOrLink,
  newPropertySchema,
  propertyIdSchema,
  propertySlug,
  setPropertyStatus,
  type NewProperty,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import { AGENT, at, OWNER } from '../../support/domain.js';

const SHOP: NewProperty = {
  slug: 'tetiiv-orenda-3f9a',
  title: 'Тетіїв, Соборна, 42 м², оренда',
  kind: 'commercial',
  deal: 'rent',
  region: 'Київська',
  settlement: 'Тетіїв',
  street: 'Соборна',
  areaM2: 42,
  priceCents: 25_000,
  negotiable: true,
  rentTerms: 'Від 11 місяців, депозит — один місяць.',
  cons: 'Вхід зі двору, без вітрини.',
};

const id = () => propertyIdSchema.parse(uuidv7());

describe('an own object (phase 36, ADR-0016)', () => {
  it('is added only by the owner, as a draft', () => {
    const shop = createProperty(SHOP, { id: id(), actor: OWNER, at: at() });
    expect(shop).toMatchObject({ status: 'draft', version: 1, createdBy: OWNER });
    expect(() => createProperty(SHOP, { id: id(), actor: AGENT, at: at() })).toThrow(DomainError);
  });

  it('keeps the exact address, contacts and links off the page', () => {
    const invalid = (patch: Partial<NewProperty>) =>
      newPropertySchema.safeParse({ ...SHOP, ...patch }).success;
    expect(invalid({ street: 'Соборна 42' })).toBe(false);
    expect(invalid({ street: 'Соборна, 42а' })).toBe(false);
    expect(invalid({ street: 'Миру 7/2' })).toBe(false);
    expect(invalid({ street: '8 Березня' })).toBe(true);
    expect(invalid({ offer: 'Дзвоніть 067 123 45 67' })).toBe(false);
    expect(invalid({ offer: 'Пишіть на owner@example.com' })).toBe(false);
    expect(invalid({ nearby: 'Дивіться olx.ua' })).toBe(false);
    expect(invalid({ nearby: 'https://example.org/map' })).toBe(false);
    expect(hasContactOrLink('Ринок за 200 м, зупинка поруч')).toBe(false);
  });

  it('checks the facts that belong together', () => {
    expect(newPropertySchema.safeParse({ ...SHOP, floor: 3, floors: 2 }).success).toBe(false);
    expect(newPropertySchema.safeParse({ ...SHOP, deal: 'sale' }).success).toBe(false);
    expect(newPropertySchema.safeParse({ ...SHOP, areaM2: 42.25 }).success).toBe(false);
    expect(newPropertySchema.safeParse({ ...SHOP, priceCents: 0 }).success).toBe(false);
    expect(newPropertySchema.safeParse({ ...SHOP, title: 'Два\nрядки' }).success).toBe(false);
  });

  it('moves draft → listed ⇄ under offer → closed, and only by the owner', () => {
    const draft = createProperty(SHOP, { id: id(), actor: OWNER, at: at() });
    expect(() => setPropertyStatus(draft, 'listed', { actor: AGENT, at: at(1) })).toThrow(
      DomainError,
    );
    expect(() => setPropertyStatus(draft, 'closed', { actor: OWNER, at: at(1) })).toThrow(
      DomainError,
    );
    const listed = setPropertyStatus(draft, 'listed', { actor: OWNER, at: at(1) });
    const offer = setPropertyStatus(listed, 'under_offer', { actor: OWNER, at: at(2) });
    const back = setPropertyStatus(offer, 'listed', { actor: OWNER, at: at(3) });
    const closed = setPropertyStatus(back, 'closed', { actor: OWNER, at: at(4) });
    expect(closed).toMatchObject({ status: 'closed', version: 5 });
    expect(() => setPropertyStatus(closed, 'listed', { actor: OWNER, at: at(5) })).toThrow(
      DomainError,
    );
  });

  it('gets a latin address from the settlement and the deal', () => {
    expect(propertySlug('Тетіїв', 'rent', '3F9A')).toBe('tetiiv-orenda-3f9a');
    expect(propertySlug('Біла Церква', 'sale', 'b2c1')).toBe('bila-tserkva-prodazh-b2c1');
    expect(propertySlug('Тетиев', 'sale', '0a1b')).toBe('tetyev-prodazh-0a1b');
  });
});
