import { z } from 'zod';
import {
  assertOwner,
  mutableMeta,
  mutableMetaShape,
  parseEntity,
  type CreateContext,
  type DomainContext,
} from '../entity.js';
import { DomainError } from '../errors.js';
import {
  checkoutIdSchema,
  experimentIdSchema,
  hypothesisIdSchema,
  opportunityIdSchema,
  timestampSchema,
  type CheckoutId,
} from '../primitives.js';

/*
 * Payments (PHASE 20b, ADR-0009): the payment link of a preorder test at the merchant of
 * record. The owner sets it; a signed test-mode order from the provider marks it tested — the
 * Release Gate's "payment flow tested" (§7.2). The system never charges anyone itself.
 */

export const CHECKOUT_PROVIDERS = ['lemonsqueezy'] as const;
export type CheckoutProvider = (typeof CHECKOUT_PROVIDERS)[number];

export const CHECKOUT_STATUSES = ['active', 'retired'] as const;

export const MAX_CHECKOUT_URL_LENGTH = 500;

/** A Lemon Squeezy payment link: https on a store subdomain, a `/buy/` or `/checkout/buy/` path. */
export const checkoutUrlSchema = z
  .string()
  .trim()
  .max(MAX_CHECKOUT_URL_LENGTH)
  .refine(
    (value) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return false;
      }
      return (
        url.protocol === 'https:' &&
        url.username === '' &&
        url.password === '' &&
        url.port === '' &&
        /^[a-z0-9-]+\.lemonsqueezy\.com$/.test(url.hostname) &&
        /^\/(?:checkout\/)?buy\/[A-Za-z0-9-]+\/?$/.test(url.pathname) &&
        url.hash === ''
      );
    },
    { message: 'a Lemon Squeezy payment link (https://<store>.lemonsqueezy.com/buy/<id>)' },
  );

const newCheckoutShape = {
  experimentId: experimentIdSchema,
  hypothesisId: hypothesisIdSchema,
  opportunityId: opportunityIdSchema,
  provider: z.enum(CHECKOUT_PROVIDERS),
  url: checkoutUrlSchema,
};

export const newCheckoutSchema = z.strictObject(newCheckoutShape);
export type NewCheckout = z.infer<typeof newCheckoutSchema>;

export const checkoutSchema = z.object({
  ...newCheckoutShape,
  id: checkoutIdSchema,
  status: z.enum(CHECKOUT_STATUSES),
  /** When a signed test-mode order of this test arrived (§7.2 "payment flow tested"). */
  testedAt: timestampSchema.optional(),
  ...mutableMetaShape,
});
export type Checkout = z.infer<typeof checkoutSchema>;

/** The owner sets the payment link of a test. */
export function createCheckout(data: NewCheckout, context: CreateContext<CheckoutId>): Checkout {
  assertOwner(context.actor, 'set a payment link');
  return parseEntity(checkoutSchema, 'checkout', {
    ...data,
    id: context.id,
    status: 'active',
    ...mutableMeta(context),
  });
}

/**
 * The owner replaces the link, e.g. the live link after the test-mode one. The test payment
 * stays: it proved that orders of this test reach the system.
 */
export function changeCheckoutUrl(
  checkout: Checkout,
  url: string,
  context: DomainContext,
): Checkout {
  assertOwner(context.actor, 'change a payment link');
  if (checkout.status !== 'active') {
    throw new DomainError('invalid_transition', 'The payment link is retired', {});
  }
  return parseEntity(checkoutSchema, 'checkout', {
    ...checkout,
    url,
    updatedAt: context.at,
    version: checkout.version + 1,
  });
}

/** A signed test-mode order of the test arrived: the payment flow is tested. */
export function markCheckoutTested(checkout: Checkout, context: DomainContext): Checkout {
  if (context.actor.type !== 'integration' && context.actor.type !== 'owner') {
    throw new DomainError('owner_required', 'Only the payment provider or the owner', {
      actor_type: context.actor.type,
    });
  }
  if (checkout.testedAt !== undefined) {
    throw new DomainError('invalid_transition', 'The payment link is already tested', {});
  }
  return parseEntity(checkoutSchema, 'checkout', {
    ...checkout,
    testedAt: context.at,
    updatedAt: context.at,
    version: checkout.version + 1,
  });
}
