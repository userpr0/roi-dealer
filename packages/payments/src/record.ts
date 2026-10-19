import {
  ConstraintViolationError,
  type Database,
  type TransactionScope,
} from '@roi-dealer/database';
import {
  AUTOMATION_CONTROL_ID,
  costEntryIdSchema,
  DomainError,
  markCheckoutTested,
  recordRefund,
  recordRevenueEntry,
  revenueEntryIdSchema,
  toTimestamp,
  usd,
  type Actor,
  type Experiment,
  type NewPrincipal,
  type Timestamp,
} from '@roi-dealer/domain';
import type { Logger } from '@roi-dealer/observability';
import { uuidv7 } from '@roi-dealer/shared';
import {
  LEMONSQUEEZY,
  parseLemonSqueezyEvent,
  verifyLemonSqueezySignature,
  type PaymentEvent,
} from './lemonsqueezy.js';

/*
 * Recording what the provider reported (PHASE 20b, ADR-0009): a test-mode order marks the
 * test's payment link tested; a paid order is revenue (a preorder for a preorder test) and the
 * funnel's `payment` step; a refund is a `refund` cost of the test for the amount refunded since
 * the last report. Each event once, in one transaction with its journal line.
 */

/** The identity the provider's webhooks write as; the owner grants it in /decisions. */
export const PAYMENTS: Actor = { type: 'integration', id: LEMONSQUEEZY };

export const PAYMENTS_ACCESS: NewPrincipal = {
  actor: PAYMENTS,
  displayName: 'Платежи Lemon Squeezy',
  purpose:
    'Записывает оплаты и возвраты, о которых сообщает Lemon Squeezy подписанным webhook: ' +
    'выручку тестов, шаг воронки «оплаты», возвраты и проверку оплаты тестовым платежом. ' +
    'Ничего не списывает и не тратит; имя и почту покупателя не хранит.',
};

export type PaymentOutcome =
  | 'test_recorded'
  | 'revenue_recorded'
  | 'refund_recorded'
  | 'refund_unallocated'
  | 'duplicate'
  | 'ignored'
  | 'paused'
  | 'no_access';

/** Experiments whose refunds are recorded: launched ones (the domain's `recordRefund`). */
const LAUNCHED = ['running', 'stopped', 'completed'];

function isDuplicate(error: unknown): boolean {
  return error instanceof ConstraintViolationError && error.constraint === 'payment_events_once';
}

async function experimentOf(
  scope: Pick<TransactionScope, 'repositories'>,
  id: Experiment['id'] | undefined,
): Promise<Experiment | undefined> {
  return id === undefined ? undefined : scope.repositories.experiments.getById(id);
}

export interface PaymentDeps {
  readonly database: Pick<Database, 'repositories' | 'transaction'>;
  readonly logger: Logger;
  readonly now?: () => number;
}

/**
 * Records a verified provider event. The kill switch comes first; without the owner's grant
 * nothing is written (`no_access`) and the provider is asked to deliver again later.
 */
export async function recordPaymentEvent(
  deps: PaymentDeps,
  event: PaymentEvent,
  correlationId?: string,
): Promise<PaymentOutcome> {
  const { database } = deps;
  if (event.kind === 'ignored') return 'ignored';
  const control = await database.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
  if (control === undefined) throw new Error('the automation kill switch is missing');
  if (control.status === 'paused') return 'paused';
  const principal = await database.repositories.principals.getByActor(PAYMENTS);
  if (principal?.status !== 'active') return 'no_access';
  const at: Timestamp = toTimestamp(new Date((deps.now ?? Date.now)()));

  try {
    return await database.transaction(
      async (scope) => {
        if (event.kind === 'order' && event.testMode) {
          await scope.payments.record(
            {
              provider: LEMONSQUEEZY,
              eventKey: `test_order:${event.orderId}`,
              kind: 'test_order',
              orderId: event.orderId,
              experimentId: (await experimentOf(scope, event.experimentId))?.id,
              amount: usd(event.netCents),
              receivedAt: at,
              correlationId,
            },
            PAYMENTS,
          );
          if (event.experimentId !== undefined) {
            const [checkout] = await scope.repositories.checkouts.listActiveByExperiments([
              event.experimentId,
            ]);
            if (checkout !== undefined && checkout.testedAt === undefined) {
              await scope.repositories.checkouts.update(
                markCheckoutTested(checkout, { actor: PAYMENTS, at }),
                PAYMENTS,
              );
            }
          }
          return 'test_recorded';
        }
        // Test-mode refunds move no money.
        if (event.testMode) return 'ignored';
        const experiment = await experimentOf(scope, event.experimentId);
        if (event.kind === 'order') return recordOrder(scope, event, experiment, at, correlationId);
        return recordRefundEvent(scope, event, experiment, at, correlationId);
      },
      { correlationId },
    );
  } catch (error) {
    if (isDuplicate(error)) return 'duplicate';
    throw error;
  }
}

async function recordOrder(
  scope: TransactionScope,
  event: Extract<PaymentEvent, { kind: 'order' }>,
  experiment: Experiment | undefined,
  at: Timestamp,
  correlationId: string | undefined,
): Promise<PaymentOutcome> {
  const hypothesis =
    experiment === undefined
      ? undefined
      : await scope.repositories.hypotheses.getById(experiment.hypothesisId);
  if (event.netCents === 0) {
    await scope.payments.record(
      {
        provider: LEMONSQUEEZY,
        eventKey: `order:${event.orderId}`,
        kind: 'order',
        orderId: event.orderId,
        experimentId: experiment?.id,
        amount: usd(0),
        receivedAt: at,
        correlationId,
      },
      PAYMENTS,
    );
    return 'ignored';
  }
  const revenue = recordRevenueEntry(
    {
      // Money paid before the product exists is a preorder until it is delivered (D-014 п.8).
      kind: hypothesis?.validationMethod === 'preorder' ? 'preorder' : 'payment',
      amount: usd(event.netCents),
      customers: 1,
      description: `Lemon Squeezy order ${event.orderId}`,
      receivedAt: at,
      allocation:
        experiment === undefined
          ? {}
          : {
              opportunityId: experiment.opportunityId,
              hypothesisId: experiment.hypothesisId,
              experimentId: experiment.id,
            },
    },
    { id: revenueEntryIdSchema.parse(uuidv7()), actor: PAYMENTS, at },
  );
  await scope.repositories.revenueEntries.insert(revenue);
  // A repeated delivery fails on the journal's key and rolls the revenue back.
  await scope.payments.record(
    {
      provider: LEMONSQUEEZY,
      eventKey: `order:${event.orderId}`,
      kind: 'order',
      orderId: event.orderId,
      experimentId: experiment?.id,
      amount: revenue.amount,
      revenueEntryId: revenue.id,
      receivedAt: at,
      correlationId,
    },
    PAYMENTS,
  );
  if (experiment?.status === 'running' && hypothesis !== undefined) {
    await scope.funnel.record(
      [
        {
          experimentId: experiment.id,
          hypothesisId: experiment.hypothesisId,
          stage: 'payment',
          quantity: 1,
          channel: hypothesis.channel,
          utm: event.utmSource === undefined ? {} : { source: event.utmSource },
          occurredAt: at,
          source: 'tracker',
        },
      ],
      PAYMENTS,
      correlationId,
    );
  }
  return 'revenue_recorded';
}

async function recordRefundEvent(
  scope: TransactionScope,
  event: Extract<PaymentEvent, { kind: 'refund' }>,
  experiment: Experiment | undefined,
  at: Timestamp,
  correlationId: string | undefined,
): Promise<PaymentOutcome> {
  const before = await scope.payments.refunded(LEMONSQUEEZY, event.orderId);
  const delta = event.refundedNetCents - before.amountCents;
  if (delta <= 0) return 'duplicate';
  const entry = {
    provider: LEMONSQUEEZY,
    eventKey: `refund:${event.orderId}:${String(event.refundedNetCents)}`,
    kind: 'refund',
    orderId: event.orderId,
    experimentId: experiment?.id,
    amount: usd(delta),
    receivedAt: at,
    correlationId,
  } as const;
  if (experiment === undefined || !LAUNCHED.includes(experiment.status)) {
    await scope.payments.record(entry, PAYMENTS);
    return 'refund_unallocated';
  }
  const flow = (await scope.economics.moneyFlows([experiment.id])).get(experiment.id);
  const refundable = usd(
    (flow?.payments.amountCents ?? 0) +
      (flow?.preorders.amountCents ?? 0) -
      (flow?.refunds.amountCents ?? 0),
  );
  let refund;
  try {
    refund = recordRefund(
      {
        amount: usd(delta),
        description: `Lemon Squeezy refund of order ${event.orderId}`,
        incurredAt: at,
      },
      experiment,
      refundable,
      { id: costEntryIdSchema.parse(uuidv7()), actor: PAYMENTS, at },
    );
  } catch (error) {
    // More than the test received through the system: the owner reconciles it by hand.
    if (!(error instanceof DomainError) || error.code !== 'invariant_violation') throw error;
    await scope.payments.record(entry, PAYMENTS);
    return 'refund_unallocated';
  }
  await scope.repositories.costEntries.insert(refund);
  await scope.payments.record({ ...entry, costEntryId: refund.id }, PAYMENTS);
  return 'refund_recorded';
}

export interface WebhookResult {
  /** 200 recorded or ignored; 401 bad signature; 400 unreadable; 503 retry later. */
  readonly status: 200 | 400 | 401 | 503;
  readonly outcome: PaymentOutcome | 'bad_signature' | 'unreadable';
}

/**
 * A Lemon Squeezy webhook (ADR-0009): signature first, then the event, then the record. The
 * provider delivers again after a 503 (kill switch, no access yet). Nothing of the body is logged.
 */
export async function handleLemonSqueezyWebhook(
  deps: PaymentDeps,
  request: {
    readonly body: string;
    readonly signature: string | undefined;
    readonly secret: string;
    readonly correlationId?: string | undefined;
  },
): Promise<WebhookResult> {
  if (!verifyLemonSqueezySignature(request.body, request.signature, request.secret)) {
    return { status: 401, outcome: 'bad_signature' };
  }
  let event: PaymentEvent;
  try {
    event = parseLemonSqueezyEvent(request.body);
  } catch {
    return { status: 400, outcome: 'unreadable' };
  }
  const outcome = await recordPaymentEvent(deps, event, request.correlationId);
  deps.logger.info('payment webhook', {
    kind: event.kind,
    outcome,
    test_mode: event.kind === 'ignored' ? undefined : event.testMode,
  });
  return { status: outcome === 'paused' || outcome === 'no_access' ? 503 : 200, outcome };
}
