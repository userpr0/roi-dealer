import { randomBytes } from 'node:crypto';
import type { Database } from '@roi-dealer/database';
import {
  changeCheckoutUrl,
  checkoutIdSchema,
  checkoutUrlSchema,
  createCheckout,
  formatUsd,
  timestampMs,
  type Actor,
  type Checkout,
  type Experiment,
  type Hypothesis,
  type Timestamp,
} from '@roi-dealer/domain';
import type { RecordedPaymentEvent } from '@roi-dealer/database';
import { uuidv7 } from '@roi-dealer/shared';
import { callbackButton, type CallbackContext, type CommandContext } from '@roi-dealer/telegram';
import { experimentNumbers } from './experiments.js';
import { shorten } from './texts.js';

/*
 * Payments in the panel (PHASE 20b, ADR-0009): the owner gives a preorder test its Lemon
 * Squeezy payment link with /checkout; the provider's signed test-mode order marks it tested
 * (Release Gate §7.2); orders and refunds arrive as notices. The system never charges anyone.
 */

/** Confirmations of /checkout: `pl:<y|n>:<nonce>`. */
export const CHECKOUT_PREFIX = 'pl';
const CONFIRMATION_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;
/** Tests that may get a payment link: not finished. */
const OPEN_STATUSES = ['planned', 'awaiting_approval', 'approved', 'running', 'stopped'];

export interface PaymentFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (telegramUserId: number) => Actor;
}

export const CHECKOUT_USAGE = [
  '💳 Ссылка на оплату предзаказа: /checkout <№ теста> <ссылка Lemon Squeezy>',
  'Например: /checkout 2 https://mystore.lemonsqueezy.com/buy/2f1c…',
  'Сначала — ссылка из Test mode и тестовая покупка (карта 4242 4242 4242 4242): бот напишет, ' +
    'что оплата проверена. Потом — та же команда с боевой ссылкой.',
].join('\n');

/** The payment line of a preorder test's card (PHASE 20b). */
export function paymentLine(
  hypothesis: Pick<Hypothesis, 'validationMethod' | 'price'>,
  checkout: Checkout | undefined,
  number: number,
): string | undefined {
  if (hypothesis.validationMethod !== 'preorder' || hypothesis.price.amountCents === 0) {
    return undefined;
  }
  if (checkout === undefined) {
    return `💳 Оплата: ссылки нет — /checkout ${String(number)} <ссылка Lemon Squeezy>`;
  }
  return checkout.testedAt === undefined
    ? '💳 Оплата: Lemon Squeezy · ждёт тестовую покупку в Test mode'
    : '💳 Оплата: Lemon Squeezy · проверена тестовым платежом ✅';
}

interface PendingCheckout {
  readonly experimentId: Experiment['id'];
  readonly url: string;
  readonly expiresAtMs: number;
}

export interface CheckoutFlow {
  readonly checkout: (context: CommandContext) => Promise<void>;
  readonly handleButton: (context: CallbackContext) => Promise<void>;
}

/** /checkout: the owner sets or replaces the payment link of a preorder test, with confirmation. */
export function createCheckoutFlow(deps: PaymentFlowDeps): CheckoutFlow {
  const pending = new Map<string, PendingCheckout>();
  const nowMs = (): number => timestampMs(deps.now());

  return {
    async checkout(context) {
      const [rawNumber, rawUrl, ...rest] = context.args.trim().split(/\s+/);
      const number = Number(rawNumber?.replace(/^№/, ''));
      const url = checkoutUrlSchema.safeParse(rawUrl ?? '');
      if (!Number.isSafeInteger(number) || number < 1 || !url.success || rest.length > 0) {
        await context.reply(CHECKOUT_USAGE);
        return;
      }
      const { repositories } = deps.database;
      const numbers = await experimentNumbers(repositories);
      const experimentId = [...numbers].find(([, value]) => value === number)?.[0];
      const experiment =
        experimentId === undefined
          ? undefined
          : await repositories.experiments.getById(experimentId);
      if (experiment === undefined || !OPEN_STATUSES.includes(experiment.status)) {
        await context.reply(`Теста №${String(number)} нет. Номера — в /experiments.`);
        return;
      }
      const hypothesis = await repositories.hypotheses.getById(experiment.hypothesisId);
      if (hypothesis?.validationMethod !== 'preorder' || hypothesis.price.amountCents === 0) {
        await context.reply(
          `⛔ Тест №${String(number)} — не платный предзаказ: страница обещает «в разработке», ` +
            'оплату там не берут. Ссылка на оплату — только для предзаказа.',
        );
        return;
      }
      const [current] = await repositories.checkouts.listActiveByExperiments([experiment.id]);
      const at = nowMs();
      for (const [nonce, item] of pending) {
        if (item.expiresAtMs <= at) pending.delete(nonce);
      }
      while (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      const nonce = randomBytes(8).toString('hex');
      pending.set(nonce, {
        experimentId: experiment.id,
        url: url.data,
        expiresAtMs: at + CONFIRMATION_TTL_MS,
      });
      await context.reply(
        [
          `💳 Тест №${String(number)} · цена ${formatUsd(hypothesis.price)} (из гипотезы)`,
          current === undefined
            ? 'Ссылки на оплату ещё нет.'
            : `Сейчас: ${current.url}` +
              (current.testedAt === undefined ? '' : ' · проверена тестовым платежом'),
          `Станет: ${url.data}`,
          'Кнопка страницы поведёт на эту ссылку; оплату примет Lemon Squeezy. Цена в товаре ' +
            'Lemon Squeezy должна совпадать с ценой на странице.',
          '',
          'Записать? Подтверждение действует 10 минут.',
        ].join('\n'),
        [
          [
            callbackButton('💳 Записать', `${CHECKOUT_PREFIX}:y:${nonce}`),
            callbackButton('Отмена', `${CHECKOUT_PREFIX}:n:${nonce}`),
          ],
        ],
      );
    },

    async handleButton(context) {
      const [answer, nonce] = context.data.split(':');
      const confirmation = nonce === undefined ? undefined : pending.get(nonce);
      if (answer === 'n' && nonce !== undefined) {
        pending.delete(nonce);
        await context.edit('Отменено. Ничего не записано.');
        return;
      }
      if (answer !== 'y' || confirmation === undefined || confirmation.expiresAtMs <= nowMs()) {
        await context.edit('⌛ Подтверждение устарело. Повторите /checkout.');
        return;
      }
      const actor = deps.owner(context.userId);
      const { result } = await deps.database.command(
        {
          name: 'checkout.set',
          idempotencyKey: `tg-callback-${context.callbackQueryId}`,
          correlationId: `tg-update-${String(context.updateId)}`,
        },
        async (scope): Promise<{ readonly tested: boolean } | undefined> => {
          const experiment = await scope.repositories.experiments.getById(
            confirmation.experimentId,
          );
          if (experiment === undefined || !OPEN_STATUSES.includes(experiment.status)) {
            return undefined;
          }
          const at = deps.now();
          const [current] = await scope.repositories.checkouts.listActiveByExperiments([
            experiment.id,
          ]);
          if (current === undefined) {
            await scope.repositories.checkouts.insert(
              createCheckout(
                {
                  experimentId: experiment.id,
                  hypothesisId: experiment.hypothesisId,
                  opportunityId: experiment.opportunityId,
                  provider: 'lemonsqueezy',
                  url: confirmation.url,
                },
                { id: checkoutIdSchema.parse(uuidv7()), actor, at },
              ),
            );
            return { tested: false };
          }
          if (current.url !== confirmation.url) {
            await scope.repositories.checkouts.update(
              changeCheckoutUrl(current, confirmation.url, { actor, at }),
              actor,
            );
          }
          return { tested: current.testedAt !== undefined };
        },
      );
      if (nonce !== undefined) pending.delete(nonce);
      if (result === undefined) {
        await context.edit('⚠️ Тест закончился или не найден. Ничего не записано.');
        return;
      }
      context.logger.info('payment link set by the owner', { tested: result.tested });
      await context.edit(
        result.tested
          ? '💳 Записано. Оплата уже проверена тестовым платежом.'
          : '💳 Записано. Сделайте тестовую покупку по ссылке в Test mode — бот напишет, ' +
              'когда оплата проверена. Без этого Release Gate платный предзаказ не выпустит.',
      );
      await context.answer('Записано');
    },
  };
}

/** The owner's notice of what the provider reported (no buyer data: there is none). */
export function paymentNoticeText(
  event: RecordedPaymentEvent,
  test: { readonly number?: number | undefined; readonly title?: string | undefined },
): string {
  const where =
    test.title === undefined
      ? 'без теста (ссылка без номера теста)'
      : `тест${test.number === undefined ? '' : ` №${String(test.number)}`} «${shorten(test.title, 100)}»`;
  switch (event.kind) {
    case 'test_order':
      return `✅ Тестовый платёж дошёл: ${where}. Оплата проверена — можно ставить боевую ссылку (/checkout) и проходить Release Gate.`;
    case 'order':
      return `💰 Оплата ${formatUsd(event.amount)} без налога: ${where}. В выручке и воронке — сама.`;
    case 'refund':
      return event.costEntryId === undefined
        ? `↩️ Возврат ${formatUsd(event.amount)}: ${where}. Не записан в тест — внесите его сами (/funnel … вернули).`
        : `↩️ Возврат ${formatUsd(event.amount)}: ${where}. Записан в расходы теста.`;
  }
}

/** Sends one notice per payment event of the last days; keys make each notice once. */
export async function sendPaymentNotices(
  database: Database,
  deliver: (text: string) => Promise<void>,
  nowMs: number,
): Promise<number> {
  const events = await database.payments.since(
    new Date(nowMs - 7 * 86_400_000).toISOString() as Timestamp,
    50,
  );
  if (events.length === 0) return 0;
  const numbers = await experimentNumbers(database.repositories);
  let sent = 0;
  for (const event of events) {
    const key = `payment-notice-${event.id}`;
    const { outcome } = await database.command(
      { name: 'payment.notice', idempotencyKey: key, correlationId: key },
      async (scope) => {
        const experiment =
          event.experimentId === undefined
            ? undefined
            : await scope.repositories.experiments.getById(event.experimentId);
        const opportunity =
          experiment === undefined
            ? undefined
            : await scope.repositories.opportunities.getById(experiment.opportunityId);
        await deliver(
          paymentNoticeText(event, {
            number: experiment === undefined ? undefined : numbers.get(experiment.id),
            title: opportunity?.title,
          }),
        );
        return { sentAt: new Date(nowMs).toISOString() };
      },
    );
    if (outcome === 'executed') sent += 1;
  }
  return sent;
}
