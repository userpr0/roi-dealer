import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { INIT_DATA_MAX_AGE_SECONDS, signInitData, verifyInitData } from '@roi-dealer/telegram';

const TOKEN = '123456:test-token-for-init-data';
const NOW_MS = 1_800_000_000_000;
const AUTH_DATE = String(NOW_MS / 1_000 - 60);
const USER = JSON.stringify({ id: 4242, first_name: 'Owner' });

const fields = (extra: Record<string, string> = {}) => ({
  auth_date: AUTH_DATE,
  query_id: 'AAE',
  user: USER,
  ...extra,
});

/** Telegram's algorithm written out independently of the package. */
function telegramHash(entries: [string, string][], token: string): string {
  const check = [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  return createHmac('sha256', secret).update(check).digest('hex');
}

describe('Mini App initData (PHASE 13, ADR-0008)', () => {
  it('accepts data signed for this bot and reads only the user id', () => {
    expect(verifyInitData(signInitData(fields(), TOKEN), TOKEN, NOW_MS)).toEqual({
      ok: true,
      userId: 4242,
      authDate: Number(AUTH_DATE),
    });
  });

  it('matches Telegram’s algorithm', () => {
    const entries = Object.entries(fields());
    const initData = new URLSearchParams([
      ...entries,
      ['hash', telegramHash(entries, TOKEN)],
    ]).toString();
    expect(verifyInitData(initData, TOKEN, NOW_MS)).toMatchObject({ ok: true, userId: 4242 });
  });

  it('refuses another bot’s signature and any changed field', () => {
    expect(verifyInitData(signInitData(fields(), '999:other'), TOKEN, NOW_MS)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const signed = new URLSearchParams(signInitData(fields(), TOKEN));
    signed.set('user', JSON.stringify({ id: 1, first_name: 'Owner' }));
    expect(verifyInitData(signed.toString(), TOKEN, NOW_MS)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const extra = new URLSearchParams(signInitData(fields(), TOKEN));
    extra.append('start_param', 'x');
    expect(verifyInitData(extra.toString(), TOKEN, NOW_MS)).toMatchObject({ ok: false });
    const short = new URLSearchParams(signInitData(fields(), TOKEN));
    short.set('hash', 'abc');
    expect(verifyInitData(short.toString(), TOKEN, NOW_MS)).toMatchObject({ ok: false });
  });

  it('accepts Telegram’s third-party signature field inside or outside the checked string', () => {
    const inside = signInitData(fields({ signature: 'ed25519-signature' }), TOKEN);
    expect(verifyInitData(inside, TOKEN, NOW_MS)).toMatchObject({ ok: true });
    const outside = new URLSearchParams(signInitData(fields(), TOKEN));
    outside.append('signature', 'ed25519-signature');
    expect(verifyInitData(outside.toString(), TOKEN, NOW_MS)).toMatchObject({ ok: true });
  });

  it('refuses old, empty and incomplete data', () => {
    const old = String(NOW_MS / 1_000 - INIT_DATA_MAX_AGE_SECONDS - 1);
    expect(verifyInitData(signInitData(fields({ auth_date: old }), TOKEN), TOKEN, NOW_MS)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyInitData(undefined, TOKEN, NOW_MS)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyInitData(' ', TOKEN, NOW_MS)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyInitData('user=1', TOKEN, NOW_MS)).toEqual({ ok: false, reason: 'malformed' });
    const noDate = signInitData({ user: USER }, TOKEN);
    expect(verifyInitData(noDate, TOKEN, NOW_MS)).toEqual({ ok: false, reason: 'malformed' });
    const noUser = signInitData({ auth_date: AUTH_DATE, chat_type: 'private' }, TOKEN);
    expect(verifyInitData(noUser, TOKEN, NOW_MS)).toEqual({ ok: false, reason: 'no_user' });
    const badUser = signInitData(fields({ user: '{' }), TOKEN);
    expect(verifyInitData(badUser, TOKEN, NOW_MS)).toEqual({ ok: false, reason: 'malformed' });
    const textId = signInitData(fields({ user: JSON.stringify({ id: '4242' }) }), TOKEN);
    expect(verifyInitData(textId, TOKEN, NOW_MS)).toEqual({ ok: false, reason: 'no_user' });
  });
});
