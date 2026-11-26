import { describe, expect, it } from 'vitest';
import { parsePropertyLeadForm } from '@roi-dealer/crm';
import { normalizePhone, propertyChannelOf } from '@roi-dealer/domain';
import { tagsOf } from '@roi-dealer/site';

const form = (fields: Record<string, string>) =>
  parsePropertyLeadForm(new URLSearchParams(fields).toString());

describe('phones of leads (phase 36)', () => {
  it('reads Ukrainian and international numbers as +<digits>', () => {
    for (const text of ['067 123 45 67', '(067) 123-45-67', '0671234567', '380671234567']) {
      expect(normalizePhone(text), text).toBe('+380671234567');
    }
    expect(normalizePhone('+380 (67) 123-45-67')).toBe('+380671234567');
    expect(normalizePhone('+48 512 345 678')).toBe('+48512345678');
    for (const text of ['12', '671234567', 'call me', '+1', '0671234567890']) {
      expect(normalizePhone(text), text).toBeUndefined();
    }
  });
});

describe('the lead form of an object page (phase 36)', () => {
  it('takes a phone, an optional name, a way to contact and the tags', () => {
    expect(
      form({
        phone: '067 123 45 67',
        name: ' Олена  Петрівна ',
        way: 'telegram',
        consent: 'yes',
        c: 'FB',
        m: 'TET01-OBH-01',
      }),
    ).toEqual({
      kind: 'valid',
      phone: '+380671234567',
      name: 'Олена Петрівна',
      way: 'telegram',
      channel: 'fb',
      material: 'tet01-obh-01',
    });
    // An unknown way is a call; an unknown channel is «other»; a bad material is dropped.
    expect(
      form({ phone: '0671234567', consent: 'yes', way: 'pigeon', c: 'radio', m: 'a b' }),
    ).toEqual({
      kind: 'valid',
      phone: '+380671234567',
      way: 'call',
      channel: 'other',
    });
  });

  it('refuses a wrong phone, a strange name or no consent, and spots a robot', () => {
    expect(form({ phone: '12', consent: 'yes' })).toEqual({ kind: 'invalid', reason: 'phone' });
    expect(form({ phone: '0671234567', name: '<b>x</b>', consent: 'yes' })).toEqual({
      kind: 'invalid',
      reason: 'name',
    });
    expect(form({ phone: '0671234567' })).toEqual({ kind: 'invalid', reason: 'consent' });
    expect(form({ phone: '0671234567', consent: 'yes', website: 'x' })).toEqual({ kind: 'trap' });
  });

  it('reads the tags of a page address the same way', () => {
    expect(tagsOf({ c: 'olx', m: 'Post-1' })).toEqual({ channel: 'olx', material: 'post-1' });
    expect(tagsOf({})).toEqual({ channel: 'other' });
    expect(propertyChannelOf(' DomRia ')).toBe('domria');
  });
});
