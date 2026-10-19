import type { AiRuntime } from '@roi-dealer/ai-runtime';
import type { Database } from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';
import type { AgentDefinition, EnsureAccess } from './agent.js';
import { runAgent, type RunResult } from './runner.js';

export interface AgentSchedule {
  readonly agent: AgentDefinition;
  readonly intervalMs: number;
}

export interface AgentSchedulerOptions {
  readonly database: Database;
  readonly logger: Logger;
  readonly runtime: Pick<AiRuntime, 'runTask'>;
  readonly ensureAccess: EnsureAccess;
  readonly agents: readonly AgentSchedule[];
  /** Default: `Date.now`. */
  readonly now?: () => number;
}

export interface AgentScheduler {
  start(): void;
  /** Runs the given agents (default: all) once now, one after another. */
  runOnce(keys?: readonly string[]): Promise<ReadonlyMap<string, RunResult>>;
  /** Cancels the timer, aborts AI calls in flight and waits for the current run. */
  stop(): Promise<void>;
}

/**
 * One scheduler for every agent (PHASE 10): each agent runs right after start and then every
 * its `intervalMs`; runs go one at a time, so an agent never runs twice at once.
 */
export function createAgentScheduler(options: AgentSchedulerOptions): AgentScheduler {
  const { logger } = options;
  const now = options.now ?? Date.now;
  const keys = new Set<string>();
  for (const { agent } of options.agents) {
    if (keys.has(agent.key)) throw new Error(`agent ${agent.key} is scheduled twice`);
    keys.add(agent.key);
  }
  const nextAt = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = true;
  let abort = new AbortController();

  async function run(schedule: AgentSchedule): Promise<RunResult> {
    try {
      return await runAgent(schedule.agent, {
        database: options.database,
        logger,
        runtime: options.runtime,
        ensureAccess: options.ensureAccess,
        now,
        signal: abort.signal,
      });
    } finally {
      nextAt.set(schedule.agent.key, now() + schedule.intervalMs);
    }
  }

  async function runDue(): Promise<void> {
    for (const schedule of options.agents) {
      if (stopped) return;
      if ((nextAt.get(schedule.agent.key) ?? 0) <= now()) await run(schedule);
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    const soonest = Math.min(...options.agents.map(({ agent }) => nextAt.get(agent.key) ?? 0));
    timer = setTimeout(
      () => {
        running = runDue().finally(() => {
          running = undefined;
          scheduleNext();
        });
      },
      Math.max(soonest - now(), 0),
    );
    timer.unref();
  }

  return {
    start() {
      if (!stopped || options.agents.length === 0) return;
      stopped = false;
      abort = new AbortController();
      nextAt.clear();
      scheduleNext();
      logger.info('agents scheduled', {
        agents: options.agents.map(({ agent, intervalMs }) => ({
          agent: agent.key,
          interval_ms: intervalMs,
        })),
      });
    },
    async runOnce(selected) {
      const results = new Map<string, RunResult>();
      for (const schedule of options.agents) {
        if (selected !== undefined && !selected.includes(schedule.agent.key)) continue;
        results.set(schedule.agent.key, await run(schedule));
      }
      return results;
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      abort.abort();
      await running;
    },
  };
}
