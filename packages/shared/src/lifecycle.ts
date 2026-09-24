import type { EventEmitter } from 'node:events';

type Fields = Readonly<Record<string, unknown>>;

/** Minimal logger contract, satisfied structurally by `@roi-dealer/observability` loggers. */
export interface LifecycleLogger {
  info(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

export type ShutdownHook = () => void | Promise<void>;

export interface ShutdownManagerOptions {
  readonly logger: LifecycleLogger;
  /** Upper bound for running all hooks. Default: 10 000 ms. */
  readonly timeoutMs?: number;
}

export interface ShutdownManager {
  /**
   * Registers a resource to release on shutdown (HTTP server, DB pool, worker loop…).
   * Hooks run once, in reverse registration order.
   */
  register(name: string, hook: ShutdownHook): void;
  /**
   * Runs all hooks. Idempotent: repeated calls return the same promise.
   * Resolves with the process exit code: `exitCode`, or 1 if a hook failed or timed out.
   */
  shutdown(reason: string, exitCode?: number): Promise<number>;
  readonly isShuttingDown: boolean;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export function createShutdownManager(options: ShutdownManagerOptions): ShutdownManager {
  const { logger } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const hooks: { readonly name: string; readonly hook: ShutdownHook }[] = [];
  let pending: Promise<number> | undefined;

  async function runHooks(): Promise<boolean> {
    let allSucceeded = true;
    for (const { name, hook } of [...hooks].reverse()) {
      try {
        await hook();
        logger.info('shutdown hook completed', { hook: name });
      } catch (error) {
        allSucceeded = false;
        logger.error('shutdown hook failed', { hook: name, error });
      }
    }
    return allSucceeded;
  }

  async function run(reason: string, exitCode: number): Promise<number> {
    logger.info('shutdown started', { reason, hooks: hooks.length });

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        logger.error('shutdown timed out', { timeout_ms: timeoutMs });
        resolve(false);
      }, timeoutMs);
    });

    const succeeded = await Promise.race([runHooks(), timedOut]);
    clearTimeout(timer);

    const code = succeeded ? exitCode : Math.max(exitCode, 1);
    logger.info('shutdown completed', { reason, exit_code: code });
    return code;
  }

  return {
    register(name, hook) {
      if (pending !== undefined) {
        throw new Error(`Cannot register shutdown hook "${name}": shutdown already started`);
      }
      hooks.push({ name, hook });
    },
    shutdown(reason, exitCode = 0) {
      pending ??= run(reason, exitCode);
      return pending;
    },
    get isShuttingDown() {
      return pending !== undefined;
    },
  };
}

export interface ProcessHandlerOptions {
  readonly logger: LifecycleLogger;
  /** Default: SIGTERM and SIGINT. */
  readonly signals?: readonly NodeJS.Signals[];
  /** Called with the final exit code. Default: {@link exitProcess}. */
  readonly exit?: (code: number) => void;
  /** Event source to listen on. Default: `process`. Injectable for tests. */
  readonly target?: EventEmitter;
}

const FORCED_EXIT_DELAY_MS = 1_000;

/**
 * Sets `process.exitCode` and lets the event loop drain so buffered stdout is flushed.
 * If something still holds the loop open, the process is force-exited after a short delay.
 */
export function exitProcess(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), FORCED_EXIT_DELAY_MS).unref();
}

/**
 * Wires OS signals and fatal process errors to the shutdown manager.
 * A second signal during shutdown forces an immediate exit with code 1.
 * Returns a function that removes the installed listeners.
 */
export function installProcessHandlers(
  manager: ShutdownManager,
  options: ProcessHandlerOptions,
): () => void {
  const { logger } = options;
  const target: EventEmitter = options.target ?? process;
  const exit = options.exit ?? exitProcess;
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];

  const onSignal = (signal: NodeJS.Signals): void => {
    if (manager.isShuttingDown) {
      logger.error('second shutdown signal received, forcing exit', { signal });
      exit(1);
      return;
    }
    logger.info('shutdown signal received', { signal });
    void manager.shutdown(`signal:${signal}`).then(exit);
  };

  const onFatal =
    (kind: 'uncaughtException' | 'unhandledRejection') =>
    (error: unknown): void => {
      logger.error('fatal process error', { kind, error });
      void manager.shutdown(kind, 1).then(exit);
    };

  const listeners: [string, (arg: unknown) => void][] = [
    ...signals.map((signal): [string, () => void] => [signal, () => onSignal(signal)]),
    ['uncaughtException', onFatal('uncaughtException')],
    ['unhandledRejection', onFatal('unhandledRejection')],
  ];

  for (const [event, listener] of listeners) target.on(event, listener);
  return () => {
    for (const [event, listener] of listeners) target.off(event, listener);
  };
}
