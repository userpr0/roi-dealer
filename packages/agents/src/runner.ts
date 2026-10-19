import type { AgentRunOutcome, AgentStop } from '@roi-dealer/database';
import { DomainError, toTimestamp } from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import {
  assertAgentsRunning,
  type AgentContext,
  type AgentDefinition,
  type AgentReport,
  type EnsureAccess,
} from './agent.js';

export interface RunnerDeps extends AgentContext {
  readonly ensureAccess: EnsureAccess;
}

/** `paused`: the kill switch was on, nothing was done or recorded. */
export type RunResult = AgentRunOutcome | 'paused';

const isPaused = (error: unknown): boolean =>
  error instanceof DomainError && error.code === 'automation_paused';

/** A short code of an error for the journal: never its message. */
export function failureCode(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'error';
  const clean = code
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .slice(0, 64);
  return clean === '' ? 'error' : clean;
}

/**
 * One run of an agent (PHASE 10): kill switch → access request (the owner grants it once in
 * /decisions) → the agent's work → a row in `agent_runs`. On pause nothing is recorded.
 */
export async function runAgent(agent: AgentDefinition, deps: RunnerDeps): Promise<RunResult> {
  const { database } = deps;
  const logger = deps.logger.child({ agent: agent.key });
  const startedAt = toTimestamp(new Date(deps.now()));
  const correlationId = `agent-run-${agent.key}-${uuidv7()}`;

  let report: AgentReport | undefined;
  let failure: string | undefined;
  let access: string | undefined;
  try {
    await assertAgentsRunning(database);
    access = (
      await deps.ensureAccess(database, agent.access, {
        at: startedAt,
        correlationId: `agent-connect-${agent.key}`,
      })
    ).state;
    report = await agent.run(deps);
  } catch (error) {
    if (isPaused(error)) {
      logger.info('agent paused by the kill switch');
      return 'paused';
    }
    failure = failureCode(error);
    logger.error(
      'agent run failed',
      error instanceof DomainError ? { code: error.code } : { code: failure, error },
    );
  }

  const stoppedBy: AgentStop | undefined = report?.stoppedBy;
  const outcome: AgentRunOutcome =
    report === undefined ? 'failed' : stoppedBy === undefined ? report.outcome : 'stopped';
  const processed = report?.processed ?? 0;
  try {
    await database.agentRuns.record({
      agent: agent.key,
      startedAt,
      finishedAt: toTimestamp(new Date(Math.max(deps.now(), Date.parse(startedAt)))),
      outcome,
      processed,
      stoppedBy: outcome === 'stopped' ? stoppedBy : undefined,
      failure: outcome === 'failed' ? failure : undefined,
      correlationId,
    });
  } catch (error) {
    logger.warn('agent run not recorded', { code: failureCode(error) });
  }
  logger.info('agent run', { outcome, processed, stopped_by: stoppedBy, access });
  return outcome;
}
