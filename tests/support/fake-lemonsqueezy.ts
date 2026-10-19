import { createHmac } from 'node:crypto';

/*
 * Webhook bodies as Lemon Squeezy sends them (PHASE 20b, ADR-0009), with the buyer's name and
 * email present — the system must ignore both — and their HMAC-SHA256 signature.
 */

export const BUYER_EMAIL = 'buyer.person@example.net';

export interface FakeOrder {
  readonly event?: 'order_created' | 'order_refunded' | 'subscription_created';
  readonly id: number;
  readonly status?: string;
  readonly totalUsd: number;
  readonly taxUsd?: number;
  readonly refundedAmountUsd?: number | undefined;
  readonly testMode?: boolean;
  readonly custom?: Readonly<Record<string, string>>;
}

export function orderBody(order: FakeOrder): string {
  const event = order.event ?? 'order_created';
  return JSON.stringify({
    meta: {
      event_name: event,
      test_mode: order.testMode ?? false,
      ...(order.custom === undefined ? {} : { custom_data: order.custom }),
    },
    data: {
      type: 'orders',
      id: String(order.id),
      attributes: {
        store_id: 1,
        customer_id: 77,
        identifier: '104e18a2-d755-4d4b-80c4-a6c1dcbe1c10',
        order_number: order.id,
        user_name: 'Buyer Person',
        user_email: BUYER_EMAIL,
        currency: 'USD',
        status: order.status ?? (event === 'order_refunded' ? 'refunded' : 'paid'),
        subtotal_usd: order.totalUsd - (order.taxUsd ?? 0),
        tax_usd: order.taxUsd ?? 0,
        total_usd: order.totalUsd,
        refunded: event === 'order_refunded',
        ...(order.refundedAmountUsd === undefined
          ? {}
          : { refunded_amount_usd: order.refundedAmountUsd }),
        test_mode: order.testMode ?? false,
      },
    },
  });
}

export function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}
