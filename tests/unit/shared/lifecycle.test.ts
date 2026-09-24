import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShutdownManager, installProcessHandlers } from '@roi-dealer/shared';
import { createCapturingLogger } from '../../support/logger.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createShutdownManager', () => {
  it('runs hooks once, in reverse registration order', async () => {
    const { logger } = createCapturingLogger();
    const manager = createShutdownManager({ logger });
    const order: string[] = [];
    manager.register('database', () => {
      order.push('database');
    });
    manager.register('http-server', async () => {
      await Promise.resolve();
      order.push('http-server');
    });

    const first = manager.shutdown('test');
    const second = manager.shutdown('again');

    expect(second).toBe(first);
    await expect(first).resolves.toBe(0);
    expect(order).toEqual(['http-server', 'database']);
    expect(manager.isShuttingDown).toBe(true);
  });

  it('continues after a failing hook and reports exit code 1', async () => {
    const { logger, records } = createCapturingLogger();
    const manager = createShutdownManager({ logger });
    const released = vi.fn();
    manager.register('first', released);
    manager.register('broken', () => {
      throw new Error('boom');
    });

    await expect(manager.shutdown('test')).resolves.toBe(1);
    expect(released).toHaveBeenCalledOnce();
    expect(records).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'shutdown hook failed', hook: 'broken' }),
    );
  });

  it('keeps a non-zero requested exit code', async () => {
    const { logger } = createCapturingLogger();
    await expect(createShutdownManager({ logger }).shutdown('fatal', 1)).resolves.toBe(1);
  });

  it('gives up after the timeout with exit code 1', async () => {
    vi.useFakeTimers();
    const { logger, records } = createCapturingLogger();
    const manager = createShutdownManager({ logger, timeoutMs: 500 });
    manager.register('hanging', () => new Promise<void>(() => undefined));

    const result = manager.shutdown('test');
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toBe(1);
    expect(records).toContainEqual(expect.objectContaining({ message: 'shutdown timed out' }));
  });

  it('rejects registrations after shutdown started', async () => {
    const { logger } = createCapturingLogger();
    const manager = createShutdownManager({ logger });
    await manager.shutdown('test');
    expect(() => manager.register('late', () => undefined)).toThrow(/shutdown already started/);
  });
});

describe('installProcessHandlers', () => {
  function setup() {
    const { logger, records } = createCapturingLogger();
    const manager = createShutdownManager({ logger });
    const target = new EventEmitter();
    const exit = vi.fn<(code: number) => void>();
    const detach = installProcessHandlers(manager, { logger, target, exit });
    return { manager, target, exit, detach, records };
  }

  it('shuts down with exit code 0 on SIGTERM', async () => {
    const { manager, target, exit } = setup();
    const hook = vi.fn();
    manager.register('resource', hook);

    target.emit('SIGTERM');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(hook).toHaveBeenCalledOnce();
  });

  it('forces exit code 1 on a second signal during shutdown', () => {
    const { manager, target, exit } = setup();
    manager.register('slow', () => new Promise<void>(() => undefined));

    target.emit('SIGINT');
    target.emit('SIGINT');

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('shuts down with exit code 1 on an unhandled rejection', async () => {
    const { target, exit, records } = setup();

    target.emit('unhandledRejection', new Error('lost promise'));

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(records).toContainEqual(
      expect.objectContaining({ message: 'fatal process error', kind: 'unhandledRejection' }),
    );
  });

  it('removes its listeners when detached', () => {
    const { target, detach } = setup();
    expect(target.listenerCount('SIGTERM')).toBe(1);
    detach();
    expect(target.eventNames()).toEqual([]);
  });
});
