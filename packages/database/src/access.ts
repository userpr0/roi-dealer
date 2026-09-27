import {
  DomainError,
  needsPrincipal,
  type Actor,
  type EntityType,
  type Principal,
} from '@roi-dealer/domain';
import { decideAccess, writePermission, type WriteOperation } from '@roi-dealer/policies';
import type { AccessLogEntry } from './access-log.js';
import { DataIntegrityError } from './errors.js';
import type { Executor, Row } from './executor.js';
import { principalsTable } from './tables.js';

/**
 * Receives refused writes. Repositories call it only after their transaction has ended, so a
 * refusal is recorded even when the write is rolled back; it must not throw.
 */
export type AccessDeniedHandler = (entry: AccessLogEntry) => Promise<void>;

/** The registered identity of a member, agent or integration, if any. */
export async function findPrincipal(
  executor: Executor,
  actor: Actor,
): Promise<Principal | undefined> {
  const [row] = await executor<Row[]>`
    select * from principals where actor_type = ${actor.type} and actor_id = ${actor.id}
  `;
  if (row === undefined) return undefined;
  const parsed = principalsTable.schema.safeParse(principalsTable.fromRow(row, {}));
  if (!parsed.success) {
    throw new DataIntegrityError(
      'principal',
      String(row['id']),
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

/**
 * Permission check of every repository write (§2.3): the role must grant the write and a
 * member, agent or integration must have an active principal. A refusal is passed to `denied`
 * (collected, recorded after the transaction) and rejected with `permission_denied`.
 */
export async function authorizeWrite(
  executor: Executor,
  entity: EntityType,
  operation: WriteOperation,
  actor: Actor,
  denied: (entry: AccessLogEntry) => void,
): Promise<void> {
  const permission = writePermission(entity, operation);
  const principal = needsPrincipal(actor) ? await findPrincipal(executor, actor) : undefined;
  const decision = decideAccess(actor, permission, principal);
  if (decision.allowed) return;
  denied({
    channel: 'database',
    actorType: actor.type,
    actorId: actor.id,
    permission,
    decision: 'denied',
    reason: decision.reason,
  });
  throw new DomainError('permission_denied', `The ${actor.type} may not ${operation} ${entity}`, {
    actor_type: actor.type,
    entity,
    operation,
    permission,
    reason: decision.reason,
  });
}
