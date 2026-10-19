import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * Telegram Mini App `initData` (PHASE 13, ADR-0008): the signed query string Telegram gives the
 * Mini App. A backend trusts it only after checking the signature with the bot token:
 * secret = HMAC-SHA256(key "WebAppData", bot token); hash = HMAC-SHA256(secret, data-check-string),
 * the received fields except `hash` sorted by key as `key=value` lines. Nothing in it is trusted
 * before that, and only the user's id is read.
 */

/** Older data is refused: a leaked `initData` stops working within a day. */
export const INIT_DATA_MAX_AGE_SECONDS = 86_400;

export type InitDataRejection = 'missing' | 'malformed' | 'bad_signature' | 'expired' | 'no_user';

export type InitDataCheck =
  | { readonly ok: true; readonly userId: number; readonly authDate: number }
  | { readonly ok: false; readonly reason: InitDataRejection };

function signature(fields: readonly (readonly [string, string])[], botToken: string): Buffer {
  const dataCheckString = [...fields]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secret).update(dataCheckString).digest();
}

function sameHash(expected: Buffer, hex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  return timingSafeEqual(expected, Buffer.from(hex, 'hex'));
}

/**
 * Checks `initData` with the bot token: the signature, its age and the user. A `signature`
 * field (Telegram's third-party Ed25519 signature) is accepted inside or outside the checked
 * string — both are covered by the bot-token HMAC, so neither can be forged.
 */
export function verifyInitData(
  initData: string | undefined,
  botToken: string,
  nowMs: number,
  maxAgeSeconds: number = INIT_DATA_MAX_AGE_SECONDS,
): InitDataCheck {
  if (initData === undefined || initData.trim() === '') return { ok: false, reason: 'missing' };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const hash = params.get('hash');
  if (hash === null) return { ok: false, reason: 'malformed' };
  const fields = [...params.entries()].filter(([key]) => key !== 'hash');
  const valid =
    sameHash(signature(fields, botToken), hash) ||
    (params.has('signature') &&
      sameHash(
        signature(
          fields.filter(([key]) => key !== 'signature'),
          botToken,
        ),
        hash,
      ));
  if (!valid) return { ok: false, reason: 'bad_signature' };

  const authDate = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) return { ok: false, reason: 'malformed' };
  if (nowMs / 1_000 - authDate > maxAgeSeconds) return { ok: false, reason: 'expired' };

  let userId: unknown;
  try {
    userId = (JSON.parse(params.get('user') ?? 'null') as { id?: unknown } | null)?.id;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) {
    return { ok: false, reason: 'no_user' };
  }
  return { ok: true, userId, authDate };
}

/** Builds signed `initData` the way Telegram does — for local fakes and tests only. */
export function signInitData(fields: Readonly<Record<string, string>>, botToken: string): string {
  const entries = Object.entries(fields);
  const hash = signature(entries, botToken).toString('hex');
  return new URLSearchParams([...entries, ['hash', hash]]).toString();
}
