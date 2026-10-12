import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLongPoller,
  TelegramApiError,
  TelegramRequestError,
  type GetUpdatesParams,
  type TelegramUpdate,
} from '@roi-dealer/telegram';
import { createCapturingLogger } from '../../support/logger.js';

afterEach(() => {
  vi.useRealTimers();
});

type Step = TelegramUpdate[] | Error;

/**
 * Fake getUpdates: returns scripted steps, then blocks until aborted (like an idle long poll).
 */
function scriptedClient(steps: Step[]) {
  const calls: GetUpdatesParams[] = [];
  const getUpdates = (params: GetUpdatesParams, signal?: AbortSignal) => {
    calls.push(params);
    const step = steps.shift();
    if (step instanceof Error) return Promise.reject(step);
    if (step !== undefined) return Promise.resolve(step);
    if (params.timeoutSeconds === 0) return Promise.resolve([]);
    return new Promise<TelegramUpdate[]>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  };
  return { client: { getUpdates }, calls };
}

function setup(steps: Step[]) {
  const { logger, records } = createCapturingLogger('bot');
  const { client, calls } = scriptedClient(steps);
  const handled: number[] = [];
  const onFatalError = vi.fn();
  const poller = createLongPoller({
    client,
    logger,
    onUpdate: (update) => {
      handled.push(update.update_id);
      return update.update_id === 2 ? Promise.reject(new Error('handler bug')) : Promise.resolve();
    },
    onFatalError,
    pollTimeoutSeconds: 30,
    maxBackoffMs: 8_000,
  });
  return { poller, calls, handled, onFatalError, records };
}

describe('createLongPoller', () => {
  it('processes updates in order, advances the offset and survives handler errors', async () => {
    const { poller, calls, handled, records } = setup([
      [{ update_id: 1 }, { update_id: 2 }],
      [{ update_id: 3 }],
    ]);

    poller.start();
    await vi.waitFor(() => expect(calls).toHaveLength(3));

    expect(handled).toEqual([1, 2, 3]);
    expect(calls.map((call) => call.offset)).toEqual([undefined, 3, 4]);
    expect(calls[0]).toMatchObject({
      timeoutSeconds: 30,
      allowedUpdates: ['message', 'callback_query'],
    });
    expect(records).toContainEqual(
      expect.objectContaining({ message: 'telegram update handler failed', update_id: 2 }),
    );
    await poller.stop();
  });

  it('confirms the offset on stop so updates are not redelivered', async () => {
    const { poller, calls } = setup([[{ update_id: 9 }]]);

    poller.start();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await poller.stop();

    expect(calls.at(-1)).toMatchObject({ offset: 10, timeoutSeconds: 0 });
    expect(poller.running).toBe(false);
  });

  it('backs off exponentially on transient errors', async () => {
    vi.useFakeTimers();
    const failure = new TelegramRequestError('getUpdates', 'timed out');
    const { poller, calls, records } = setup([failure, failure, failure, failure, failure]);

    poller.start();
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000 + 8_000);

    expect(calls).toHaveLength(6);
    const delays = records
      .filter((record) => record['message'] === 'telegram polling failed')
      .map((record) => record['retry_in_ms']);
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
    await poller.stop();
  });

  it('honours retry_after on 429 and reports 409 conflicts clearly', async () => {
    vi.useFakeTimers();
    const { poller, calls, records } = setup([
      new TelegramApiError('getUpdates', 429, 'Too Many Requests', 5),
      new TelegramApiError('getUpdates', 409, 'Conflict: terminated by other getUpdates request'),
    ]);

    poller.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);

    expect(records).toContainEqual(
      expect.objectContaining({
        message: 'telegram polling conflict: another bot instance or a webhook uses this token',
      }),
    );
    await poller.stop();
  });

  it.each([401, 404])('stops and reports a fatal error on %i', async (code) => {
    const { poller, onFatalError, calls } = setup([
      new TelegramApiError('getUpdates', code, 'Unauthorized'),
    ]);

    poller.start();
    await vi.waitFor(() => expect(onFatalError).toHaveBeenCalledOnce());
    await poller.stop();

    expect(calls).toHaveLength(1);
  });

  it('can be stopped while a long poll is pending and refuses a second start', async () => {
    const { poller, calls } = setup([]);

    poller.start();
    expect(() => poller.start()).toThrow(/already running/);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await poller.stop();
    await poller.stop();

    expect(poller.running).toBe(false);
  });
});
