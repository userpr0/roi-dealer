import { describe, expect, it } from 'vitest';
import {
  changeCheckoutUrl,
  checkoutIdSchema,
  checkoutUrlSchema,
  createCheckout,
  experimentIdSchema,
  hypothesisIdSchema,
  markCheckoutTested,
  opportunityIdSchema,
} from '@roi-dealer/domain';
import {
  checkoutLink,
  parseLemonSqueezyEvent,
  verifyLemonSqueezySignature,
} from '@roi-dealer/payments';
import { AGENT, at, createCtx, ctx, INTEGRATION, OWNER } from '../../support/domain.js';
import { orderBody, sign } from '../../support/fake-lemonsqueezy.js';

const SECRET = 'whsec-test-0123456789abcdef';
const EXPERIMENT = '0192f4c2-1111-7000-8000-000000000001';
const LINK = 'https://mystore.lemonsqueezy.com/buy/2f1c9b7e-0a6d-4d2e-9a43-5f0c1e2b3d4a';

describe('the Lemon Squeezy webhook (PHASE 20b, ADR-0009)', () => {
  const body = orderBody({ id: 1001, totalUsd: 5_880, taxUsd: 980 });

  it('accepts only the HMAC-SHA256 of the raw body with the secret', () => {
    expect(verifyLemonSqueezySignature(body, sign(body, SECRET), SECRET)).toBe(true);
    expect(verifyLemonSqueezySignature(body, sign(body, SECRET).toUpperCase(), SECRET)).toBe(true);
    expect(verifyLemonSqueezySignature(body, sign(body, 'another-secret-value'), SECRET)).toBe(
      false,
    );
    expect(verifyLemonSqueezySignature(`${body} `, sign(body, SECRET), SECRET)).toBe(false);
    expect(verifyLemonSqueezySignature(body, 'not-hex', SECRET)).toBe(false);
    expect(verifyLemonSqueezySignature(body, undefined, SECRET)).toBe(false);
  });

  it('reads a paid order without tax, the test and the source — nothing about the buyer', () => {
    const event = parseLemonSqueezyEvent(
      orderBody({
        id: 1001,
        totalUsd: 5_880,
        taxUsd: 980,
        custom: { experiment_id: EXPERIMENT, utm_source: 'reddit' },
      }),
    );
    expect(event).toEqual({
      kind: 'order',
      orderId: '1001',
      testMode: false,
      experimentId: EXPERIMENT,
      utmSource: 'reddit',
      netCents: 4_900,
    });
    expect(JSON.stringify(event)).not.toContain('buyer');
    expect(
      parseLemonSqueezyEvent(orderBody({ id: 1, totalUsd: 100, testMode: true })),
    ).toMatchObject({ kind: 'order', testMode: true, experimentId: undefined });
    expect(
      parseLemonSqueezyEvent(orderBody({ id: 2, totalUsd: 100, custom: { experiment_id: 'x' } })),
    ).toMatchObject({ kind: 'order', experimentId: undefined });
  });

  it('turns refunds into the refunded amount without tax', () => {
    const refund = (refundedAmountUsd?: number) =>
      parseLemonSqueezyEvent(
        orderBody({
          event: 'order_refunded',
          id: 1001,
          totalUsd: 5_880,
          taxUsd: 980,
          refundedAmountUsd,
        }),
      );
    expect(refund(2_940)).toMatchObject({
      kind: 'refund',
      orderId: '1001',
      refundedNetCents: 2_450,
    });
    expect(refund(5_880)).toMatchObject({ refundedNetCents: 4_900 });
    // Without the amount, `refunded: true` means the whole order.
    expect(refund()).toMatchObject({ refundedNetCents: 4_900 });
  });

  it('ignores what is not a paid order or a refund; rejects what is not an order event', () => {
    expect(parseLemonSqueezyEvent(orderBody({ id: 3, totalUsd: 100, status: 'pending' }))).toEqual({
      kind: 'ignored',
      reason: 'not_paid',
    });
    expect(
      parseLemonSqueezyEvent(orderBody({ event: 'subscription_created', id: 4, totalUsd: 100 })),
    ).toEqual({ kind: 'ignored', reason: 'other_event' });
    expect(() => parseLemonSqueezyEvent('{"meta":{}}')).toThrow();
    expect(() => parseLemonSqueezyEvent('not json')).toThrow();
  });
});

describe('the payment link (PHASE 20b)', () => {
  it('takes only Lemon Squeezy payment links', () => {
    for (const url of [LINK, 'https://shop-1.lemonsqueezy.com/checkout/buy/abc-123?enabled=1']) {
      expect(checkoutUrlSchema.safeParse(url).success).toBe(true);
    }
    for (const url of [
      'http://mystore.lemonsqueezy.com/buy/abc',
      'https://lemonsqueezy.com.evil.example/buy/abc',
      'https://mystore.lemonsqueezy.com/admin',
      'https://user:pw@mystore.lemonsqueezy.com/buy/abc',
      'https://mystore.lemonsqueezy.com:8443/buy/abc',
      'javascript:alert(1)',
    ]) {
      expect(checkoutUrlSchema.safeParse(url).success).toBe(false);
    }
  });

  it('carries the test and the source to the checkout', () => {
    const link = new URL(
      checkoutLink(`${LINK}?enabled=1`, {
        experimentId: experimentIdSchema.parse(EXPERIMENT),
        utmSource: 'reddit',
      }),
    );
    expect(link.origin).toBe('https://mystore.lemonsqueezy.com');
    expect(link.searchParams.get('enabled')).toBe('1');
    expect(link.searchParams.get('checkout[custom][experiment_id]')).toBe(EXPERIMENT);
    expect(link.searchParams.get('checkout[custom][utm_source]')).toBe('reddit');
  });

  it('is set by the owner and tested once by the provider', () => {
    const data = {
      experimentId: experimentIdSchema.parse(EXPERIMENT),
      hypothesisId: hypothesisIdSchema.parse('0192f4c2-1111-7000-8000-000000000002'),
      opportunityId: opportunityIdSchema.parse('0192f4c2-1111-7000-8000-000000000003'),
      provider: 'lemonsqueezy' as const,
      url: LINK,
    };
    expect(() => createCheckout(data, createCtx(checkoutIdSchema, AGENT, 0))).toThrow(/owner/i);
    const checkout = createCheckout(data, createCtx(checkoutIdSchema, OWNER, 0));
    expect(checkout).toMatchObject({ status: 'active', version: 1 });
    expect(checkout.testedAt).toBeUndefined();
    expect(() => markCheckoutTested(checkout, ctx(AGENT, 1))).toThrow();
    const tested = markCheckoutTested(checkout, ctx(INTEGRATION, 1));
    expect(tested).toMatchObject({ testedAt: at(1), version: 2 });
    expect(() => markCheckoutTested(tested, ctx(INTEGRATION, 2))).toThrow(/already/);
    expect(() => changeCheckoutUrl(tested, LINK, ctx(INTEGRATION, 2))).toThrow(/owner/i);
    const live = changeCheckoutUrl(
      tested,
      'https://mystore.lemonsqueezy.com/buy/live-1',
      ctx(OWNER, 2),
    );
    expect(live).toMatchObject({ testedAt: at(1), version: 3 });
    expect(() => changeCheckoutUrl(tested, 'https://evil.example/buy/1', ctx(OWNER, 2))).toThrow();
  });
});
