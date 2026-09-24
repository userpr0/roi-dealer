import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export type LogLine = Record<string, unknown>;

export interface ExitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ServiceProcess {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  /** Parsed stdout lines. Lines that are not valid JSON are kept as `{ unparsed: line }`. */
  readonly logs: readonly LogLine[];
  readonly stderr: () => string;
  waitForLog(predicate: (line: LogLine) => boolean, timeoutMs?: number): Promise<LogLine>;
  waitForExit(timeoutMs?: number): Promise<ExitResult>;
  kill(): void;
}

/**
 * Runs an app entrypoint from TypeScript sources (via tsx) as a real OS process.
 * The child gets a minimal environment, so no developer secrets leak into tests.
 */
export function startService(entry: string, env: Readonly<Record<string, string>>): ServiceProcess {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--conditions=@roi-dealer/source', entry],
    {
      cwd: REPO_ROOT,
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const logs: LogLine[] = [];
  const listeners = new Set<() => void>();
  let stderr = '';
  let exit: ExitResult | undefined;

  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      logs.push(JSON.parse(line) as LogLine);
    } catch {
      logs.push({ unparsed: line });
    }
    listeners.forEach((notify) => notify());
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('exit', (code, signal) => {
    exit = { code, signal };
    listeners.forEach((notify) => notify());
  });

  const waitFor = <T>(check: () => T | undefined, timeoutMs: number, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const evaluate = (): void => {
        const value = check();
        if (value !== undefined) {
          cleanup();
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for ${what}.\nstdout: ${JSON.stringify(logs)}\nstderr: ${stderr}`,
          ),
        );
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        listeners.delete(evaluate);
      };
      listeners.add(evaluate);
      evaluate();
    });

  return {
    child,
    logs,
    stderr: () => stderr,
    waitForLog: (predicate, timeoutMs = 15_000) =>
      waitFor(() => logs.find(predicate), timeoutMs, 'log line'),
    waitForExit: (timeoutMs = 15_000) => waitFor(() => exit, timeoutMs, 'process exit'),
    kill: () => {
      if (exit === undefined) child.kill('SIGKILL');
    },
  };
}
