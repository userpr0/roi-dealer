import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { experimentIdSchema, type ExperimentId } from '@roi-dealer/domain';

/*
 * Lemon Squeezy, the merchant of record (ADR-0009): payment links carry the test in
 * `checkout[custom][…]`; webhooks are signed with HMAC-SHA256 of the raw body (`X-Signature`,
 * hex). Only the event, the order's number, amounts, test mode and the custom data are read —
 * never the buyer's name or email.
 */

export const LEMONSQUEEZY = 'lemonsqueezy';
/** The longest webhook body the api reads. */
export const MAX_WEBHOOK_BYTES = 65_536;

/** Whether `signature` is the HMAC-SHA256 hex digest of `body` with `secret`, in constant time. */
export function verifyLemonSqueezySignature(
  body: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (signature === undefined || !/^[0-9a-f]{64}$/i.test(signature.trim())) return false;
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest();
  const given = Buffer.from(signature.trim(), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The payment link of a test: the owner's link with the test and the visit's UTM source. */
export function checkoutLink(
  url: string,
  data: { readonly experimentId: ExperimentId; readonly utmSource?: string | undefined },
): string {
  const link = new URL(url);
  link.searchParams.set('checkout[custom][experiment_id]', data.experimentId);
  if (data.utmSource !== undefined) {
    link.searchParams.set('checkout[custom][utm_source]', data.utmSource);
  }
  return link.toString();
}

const cents = z.number().int().min(0).max(100_000_000);

const orderEventSchema = z.object({
  meta: z.object({
    event_name: z.string().max(100),
    test_mode: z.boolean().optional(),
    custom_data: z.record(z.string(), z.unknown()).nullish(),
  }),
  data: z.object({
    type: z.string().max(50),
    id: z.union([z.string().max(100), z.number().int()]).transform(String),
    attributes: z.object({
      status: z.string().max(50),
      test_mode: z.boolean().optional(),
      total_usd: cents,
      tax_usd: cents.optional(),
      refunded: z.boolean().optional(),
      refunded_amount_usd: cents.optional(),
    }),
  }),
});

/** What the system records from a webhook (amounts in US cents, without tax). */
export type PaymentEvent =
  | {
      readonly kind: 'order';
      readonly orderId: string;
      readonly testMode: boolean;
      readonly experimentId?: ExperimentId | undefined;
      readonly utmSource?: string | undefined;
      /** The order's total without tax. */
      readonly netCents: number;
    }
  | {
      readonly kind: 'refund';
      readonly orderId: string;
      readonly testMode: boolean;
      readonly experimentId?: ExperimentId | undefined;
      /** Refunded so far, without tax (proportional to the order). */
      readonly refundedNetCents: number;
    }
  | { readonly kind: 'ignored'; readonly reason: string };

/**
 * Reads a verified webhook body. Orders that are not paid and other events are `ignored`;
 * a body that is not an order event throws.
 */
export function parseLemonSqueezyEvent(body: string): PaymentEvent {
  const parsed = orderEventSchema.parse(JSON.parse(body));
  const { meta, data } = parsed;
  if (data.type !== 'orders') return { kind: 'ignored', reason: 'not_an_order' };
  const { attributes } = data;
  const testMode = meta.test_mode === true || attributes.test_mode === true;
  const custom = meta.custom_data ?? {};
  const experiment = experimentIdSchema.safeParse(custom['experiment_id']);
  const utm = custom['utm_source'];
  const experimentId = experiment.success ? experiment.data : undefined;
  const netCents = Math.max(attributes.total_usd - (attributes.tax_usd ?? 0), 0);
  switch (meta.event_name) {
    case 'order_created':
      if (attributes.status !== 'paid') return { kind: 'ignored', reason: 'not_paid' };
      return {
        kind: 'order',
        orderId: data.id,
        testMode,
        experimentId,
        utmSource: typeof utm === 'string' && /^[\w .-]{1,100}$/.test(utm) ? utm.trim() : undefined,
        netCents,
      };
    case 'order_refunded': {
      const gross =
        attributes.refunded_amount_usd ?? (attributes.refunded === true ? attributes.total_usd : 0);
      // Refunds include tax; the revenue was recorded without it.
      const refundedNetCents =
        attributes.total_usd === 0
          ? 0
          : Math.min(Math.round((gross * netCents) / attributes.total_usd), netCents);
      return { kind: 'refund', orderId: data.id, testMode, experimentId, refundedNetCents };
    }
    default:
      return { kind: 'ignored', reason: 'other_event' };
  }
}
