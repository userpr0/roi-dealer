/**
 * @roi-dealer/payments — payments through a merchant of record (PHASE 20b, ADR-0009): the
 * payment link of a preorder test, the provider's signed webhooks, and the revenue, refunds and
 * test payments they report. The system never charges anyone itself.
 */
export {
  checkoutLink,
  LEMONSQUEEZY,
  MAX_WEBHOOK_BYTES,
  parseLemonSqueezyEvent,
  verifyLemonSqueezySignature,
  type PaymentEvent,
} from './lemonsqueezy.js';
export {
  handleLemonSqueezyWebhook,
  PAYMENTS,
  PAYMENTS_ACCESS,
  recordPaymentEvent,
  type PaymentDeps,
  type PaymentOutcome,
  type WebhookResult,
} from './record.js';

export const PACKAGE_NAME = '@roi-dealer/payments';
