import type { AiRuntime, AnyAiTask } from '@roi-dealer/ai-runtime';
import type { AgentStop, Database } from '@roi-dealer/database';
import {
  assertAutomationRunning,
  AUTOMATION_CONTROL_ID,
  type Actor,
  type NewPrincipal,
  type Principal,
  type Timestamp,
} from '@roi-dealer/domain';
import type { Logger } from '@roi-dealer/observability';

/** What one run of an agent gets: the database, the AI runtime and a signal to stop early. */
export interface AgentContext {
  readonly database: Database;
  readonly logger: Logger;
  readonly runtime: Pick<AiRuntime, 'runTask'>;
  readonly now: () => number;
  readonly signal: AbortSignal;
}

/** How a run ended, as the agent reports it; the runner adds `stopped` and `failed`. */
export interface AgentReport {
  readonly outcome: 'done' | 'idle' | 'no_access';
  /** Objects worked on: evidence, pains, opportunities. */
  readonly processed: number;
  readonly stoppedBy?: AgentStop | undefined;
}

/**
 * An AI agent (PHASE 10): an identity the owner grants in /decisions, the AI tasks it runs and
 * one run of its work. An agent only proposes (§2.3): it creates candidates and drafts through
 * the domain, never decisions, money or access.
 */
export interface AgentDefinition {
  /** The id of its actor, e.g. `researcher`; the key of its journal rows. */
  readonly key: string;
  readonly actor: Actor;
  /** Shown to the owner in the access request. */
  readonly access: NewPrincipal;
  readonly tasks: readonly AnyAiTask[];
  run(context: AgentContext): Promise<AgentReport>;
}

/** Asks the owner for an agent's access; `ensureAccessRequest` of the command center. */
export type EnsureAccess = (
  database: Database,
  data: NewPrincipal,
  options: { readonly at: Timestamp; readonly correlationId?: string | undefined },
) => Promise<{ readonly state: string; readonly principal: Principal }>;

/** Kill switch (13b): every automation checks it as its first step. */
export async function assertAgentsRunning(database: Database): Promise<void> {
  const control = await database.repositories.systemControls.getById(AUTOMATION_CONTROL_ID);
  if (control === undefined) {
    throw new Error('the automation kill switch is missing (migration 0003)');
  }
  assertAutomationRunning(control);
}

/** The agent's own identity, `undefined` unless the owner granted it and it is active. */
export async function activePrincipal(
  database: Database,
  actor: Actor,
): Promise<Principal | undefined> {
  const principal = await database.repositories.principals.getByActor(actor);
  return principal?.status === 'active' ? principal : undefined;
}
