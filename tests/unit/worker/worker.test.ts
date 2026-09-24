import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorker } from '../../../apps/worker/src/worker.js';
import { createCapturingLogger } from '../../support/logger.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('worker lifecycle', () => {
  it('moves idle → running → stopped', async () => {
    const { logger, records } = createCapturingLogger('worker');
    const worker = createWorker({ logger });

    expect(worker.state).toBe('idle');
    worker.start();
    expect(worker.state).toBe('running');
    await worker.stop();
    expect(worker.state).toBe('stopped');

    expect(records.map((record) => record.message)).toEqual(['worker started', 'worker stopped']);
  });

  it('emits heartbeats while running and none after stop', async () => {
    vi.useFakeTimers();
    const { logger, records } = createCapturingLogger('worker');
    const worker = createWorker({ logger, heartbeatIntervalMs: 1_000 });
    const heartbeats = () => records.filter((record) => record.message === 'worker heartbeat');

    worker.start();
    vi.advanceTimersByTime(3_000);
    expect(heartbeats()).toHaveLength(3);

    await worker.stop();
    vi.advanceTimersByTime(3_000);
    expect(heartbeats()).toHaveLength(3);
  });

  it('cannot be started twice', () => {
    const { logger } = createCapturingLogger('worker');
    const worker = createWorker({ logger });
    worker.start();
    expect(() => worker.start()).toThrow(/state "running"/);
    void worker.stop();
  });

  it('stop is idempotent', async () => {
    const { logger, records } = createCapturingLogger('worker');
    const worker = createWorker({ logger });
    worker.start();
    await worker.stop();
    await worker.stop();
    expect(records.filter((record) => record.message === 'worker stopped')).toHaveLength(1);
  });
});
