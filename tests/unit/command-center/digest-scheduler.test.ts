import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDigestScheduler,
  DIGEST_RETRY_MS,
  type DigestScheduler,
} from '@roi-dealer/command-center';
import { createCapturingLogger } from '../../support/logger.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let scheduler: DigestScheduler | undefined;

afterEach(async () => {
  await scheduler?.stop();
  scheduler = undefined;
  vi.useRealTimers();
});

function start(nowIso: string, send: (date: string) => Promise<void>) {
  vi.useFakeTimers({ now: Date.parse(nowIso) });
  const { logger, records } = createCapturingLogger('bot');
  scheduler = createDigestScheduler({ send, logger });
  scheduler.start();
  return { records };
}

describe('daily digest scheduler (10:00 Europe/Kyiv)', () => {
  it('sends at 10:00 Kyiv every day', async () => {
    const send = vi.fn(() => Promise.resolve());
    start('2026-09-25T05:00:00.000Z', send); // 08:00 Kyiv

    await vi.advanceTimersByTimeAsync(2 * HOUR - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledExactlyOnceWith('2026-09-25');

    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(send.mock.calls).toEqual([['2026-09-25'], ['2026-09-26']]);
  });

  it('keeps 10:00 Kyiv across the switch to winter time', async () => {
    const send = vi.fn(() => Promise.resolve());
    start('2026-10-24T12:00:00.000Z', send);

    await vi.advanceTimersByTimeAsync(Date.parse('2026-10-25T08:00:00.000Z') - Date.now() - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledExactlyOnceWith('2026-10-25');
  });

  it('catches up after a restart inside the window, but not later in the day', async () => {
    const late = vi.fn(() => Promise.resolve());
    start('2026-09-25T07:30:00.000Z', late); // 10:30 Kyiv
    await vi.advanceTimersByTimeAsync(0);
    expect(late).toHaveBeenCalledExactlyOnceWith('2026-09-25');
    await scheduler?.stop();

    const afternoon = vi.fn(() => Promise.resolve());
    start('2026-09-25T10:00:00.000Z', afternoon); // 13:00 Kyiv
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(afternoon).not.toHaveBeenCalled();
  });

  it('retries a failed digest every 5 minutes inside the window, then sends it once', async () => {
    const send = vi
      .fn<(date: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue(undefined);
    const { records } = start('2026-09-25T07:00:00.000Z', send);

    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledOnce();
    expect(records).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'daily digest failed', retry: true }),
    );

    await vi.advanceTimersByTimeAsync(DIGEST_RETRY_MS);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('gives up at the end of the window', async () => {
    const send = vi.fn(() => Promise.reject(new Error('down')));
    start('2026-09-25T07:00:00.000Z', send);

    await vi.advanceTimersByTimeAsync(3 * HOUR);

    // 10:00, 10:05 … 11:55 — 24 attempts, none after 12:00.
    expect(send).toHaveBeenCalledTimes(24);
  });

  it('stops', async () => {
    const send = vi.fn(() => Promise.resolve());
    start('2026-09-25T06:59:00.000Z', send);
    await scheduler?.stop();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(send).not.toHaveBeenCalled();
  });
});
