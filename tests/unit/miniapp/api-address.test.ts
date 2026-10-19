import { describe, expect, it } from 'vitest';
import { apiAddress } from '../../../apps/miniapp/src/api-address.js';

const API = 'https://api.example.test';

describe('Mini App api address (ADR-0008)', () => {
  it('prefers the build variable', () => {
    expect(apiAddress(` ${API} `, '?api=https%3A%2F%2Fother.example.test')).toBe(API);
  });

  it('takes the address the bot put into the menu button', () => {
    expect(apiAddress(undefined, `?api=${encodeURIComponent(API)}`)).toBe(API);
    expect(apiAddress('', `?api=${encodeURIComponent(`${API}/`)}`)).toBe(API);
    expect(apiAddress(undefined, '?api=http%3A%2F%2F127.0.0.1%3A8080')).toBe(
      'http://127.0.0.1:8080',
    );
  });

  it('refuses anything the signature must not be sent to', () => {
    for (const given of [
      'http://api.example.test',
      'javascript:alert(1)',
      'https://user:secret@api.example.test',
      'https://api.example.test/?next=1',
      'https://api.example.test/#x',
      'https://${{api.RAILWAY_PUBLIC_DOMAIN}}',
      'not a url',
    ]) {
      expect(apiAddress(undefined, `?api=${encodeURIComponent(given)}`)).toBeUndefined();
    }
    expect(apiAddress(undefined, '')).toBeUndefined();
  });
});
