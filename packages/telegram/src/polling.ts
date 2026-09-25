import type { Logger } from '@roi-dealer/observability';
import type { TelegramUpdate } from './api-types.js';
import { TelegramApiError, type TelegramClient } from './client.js';

export interface LongPollerOptions {
  readonly client: Pick<TelegramClient, 'getUpdates'>;
  readonly logger: Logger;
  /** Called once per update, sequentially. Errors are logged; polling continues. */
  readonly onUpdate: (update: TelegramUpdate) => Promise<void>;
  /** Called when polling cannot continue (invalid or revoked token). Polling has stopped by then. */
  readonly onFatalError: (error: Error) => void;
  /** Default: `['message', 'callback_query']` (commands and inline buttons). */
  readonly allowedUpdates?: readonly string[];
  /** Default: 30 s. */
  readonly pollTimeoutSeconds?: number;
  /** Upper bound of the exponential backoff between failed polls. Default: 30 000 ms. */
  readonly maxBackoffMs?: number;
}

export interface LongPoller {
  readonly running: boolean;
  start(): void;
  /** Stops polling and confirms processed updates so they are not redelivered after restart. */
  stop(): Promise<void>;
}

const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** 401: token invalid or revoked; 404: malformed token in the URL. Retrying cannot help. */
function isFatal(error: unknown): error is TelegramApiError {
  return error instanceof TelegramApiError && (error.errorCode === 401 || error.errorCode === 404);
}

/** Waits `ms`, resolving early when `signal` aborts so the loop can exit. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Receives updates with `getUpdates` long polling: no public endpoint or webhook is needed.
 * Delivery is at-least-once across restarts, so handlers must be idempotent.
 */
export function createLongPoller(options: LongPollerOptions): LongPoller {
  const { client, logger, onUpdate, onFatalError } = options;
  const allowedUpdates = options.allowedUpdates ?? ['message', 'callback_query'];
  const timeoutSeconds = options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let offset: number | undefined;

  function retryDelayMs(error: unknown, failures: number): number {
    if (error instanceof TelegramApiError && error.retryAfterSeconds !== undefined) {
      return error.retryAfterSeconds * 1_000;
    }
    return Math.min(maxBackoffMs, 1_000 * 2 ** (failures - 1));
  }

  async function run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      let updates: TelegramUpdate[];
      try {
        updates = await client.getUpdates(
          { ...(offset === undefined ? {} : { offset }), timeoutSeconds, allowedUpdates },
          signal,
        );
      } catch (error) {
        if (signal.aborted) return;
        if (isFatal(error)) {
          logger.error('telegram polling stopped: bot token rejected', { error });
          onFatalError(error);
          return;
        }
        failures += 1;
        const retryInMs = retryDelayMs(error, failures);
        const conflict = error instanceof TelegramApiError && error.errorCode === 409;
        logger.warn(
          conflict
            ? 'telegram polling conflict: another bot instance or a webhook uses this token'
            : 'telegram polling failed',
          { error, failures, retry_in_ms: retryInMs },
        );
        await sleep(retryInMs, signal);
        continue;
      }

      failures = 0;
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await onUpdate(update);
        } catch (error) {
          logger.error('telegram update handler failed', { update_id: update.update_id, error });
        }
      }
    }
  }

  return {
    get running() {
      return loop !== undefined;
    },

    start() {
      if (loop !== undefined) throw new Error('Telegram poller is already running');
      controller = new AbortController();
      loop = run(controller.signal);
      logger.info('telegram polling started', { timeout_s: timeoutSeconds });
    },

    async stop() {
      if (loop === undefined || controller === undefined) return;
      controller.abort();
      await loop;
      loop = undefined;

      if (offset !== undefined) {
        try {
          await client.getUpdates({ offset, timeoutSeconds: 0, allowedUpdates });
        } catch (error) {
          logger.warn('telegram offset confirmation failed', { error });
        }
      }
      logger.info('telegram polling stopped');
    },
  };
}
