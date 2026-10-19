import {
  DomainError,
  needsPrincipal,
  type Actor,
  type ExperimentId,
  type LeadId,
  type Timestamp,
} from '@roi-dealer/domain';
import { decideAccess, type Permission } from '@roi-dealer/policies';
import { findPrincipal } from './access.js';
import { translated } from './errors.js';
import type { Executor, Row } from './executor.js';

/*
 * Emails of leads (PHASE 20, migration 0017): personal data, kept apart from the history —
 * no events, no versions — and deleted for real. Capturing needs `lead.capture` (the page
 * counter); reading and deleting `lead.manage` (the owner, the retention period).
 */

export interface LeadContact {
  readonly leadId: LeadId;
  readonly experimentId: ExperimentId;
  /** Lower case. */
  readonly email: string;
  readonly createdAt: Timestamp;
}

export interface LeadContacts {
  /** Stores the email of a new lead; one email per experiment (`lead_contacts_one_per_experiment`). */
  add(contact: LeadContact, actor: Actor): Promise<void>;
  /** The lead that already has this email in the experiment, if any (to keep sign-ups idempotent). */
  leadOf(experimentId: ExperimentId, email: string, actor: Actor): Promise<LeadId | undefined>;
  /** The emails of these leads that still exist. */
  emails(leadIds: readonly LeadId[], actor: Actor): Promise<ReadonlyMap<LeadId, string>>;
  /** Every lead with this email, in all experiments (a person's deletion request). */
  leadsByEmail(email: string, actor: Actor): Promise<LeadId[]>;
  /** Deletes the emails of these leads; returns how many were deleted. */
  remove(leadIds: readonly LeadId[], actor: Actor): Promise<number>;
  /**
   * Leads past the retention period: not customers, with an email, of experiments completed or
   * cancelled before `endedBefore`.
   */
  expired(endedBefore: Timestamp, actor: Actor, limit?: number): Promise<LeadId[]>;
}

async function authorize(executor: Executor, actor: Actor, permission: Permission): Promise<void> {
  const principal = needsPrincipal(actor) ? await findPrincipal(executor, actor) : undefined;
  const decision = decideAccess(actor, permission, principal);
  if (!decision.allowed) {
    throw new DomainError('permission_denied', `The ${actor.type} may not ${permission}`, {
      actor_type: actor.type,
      permission,
      reason: decision.reason,
    });
  }
}

export function createLeadContacts(executor: Executor): LeadContacts {
  return {
    add: (contact, actor) =>
      translated(async () => {
        await authorize(executor, actor, 'lead.capture');
        await executor`
          insert into lead_contacts (lead_id, experiment_id, email, created_at)
          values (${contact.leadId}, ${contact.experimentId}, ${contact.email}, ${contact.createdAt})
        `;
      }),

    leadOf: (experimentId, email, actor) =>
      translated(async () => {
        await authorize(executor, actor, 'lead.capture');
        const [row] = await executor<Row[]>`
          select lead_id from lead_contacts
          where experiment_id = ${experimentId} and email = ${email}
        `;
        return row === undefined ? undefined : (row['lead_id'] as LeadId);
      }),

    emails: (leadIds, actor) =>
      translated(async () => {
        await authorize(executor, actor, 'lead.manage');
        if (leadIds.length === 0) return new Map();
        const rows = await executor<Row[]>`
          select lead_id, email from lead_contacts where lead_id = any(${[...leadIds]}::uuid[])
        `;
        return new Map(rows.map((row) => [row['lead_id'] as LeadId, String(row['email'])]));
      }),

    leadsByEmail: (email, actor) =>
      translated(async () => {
        await authorize(executor, actor, 'lead.manage');
        const rows = await executor<Row[]>`
          select lead_id from lead_contacts where email = ${email} order by created_at
        `;
        return rows.map((row) => row['lead_id'] as LeadId);
      }),

    remove: (leadIds, actor) =>
      translated(async () => {
        await authorize(executor, actor, 'lead.manage');
        if (leadIds.length === 0) return 0;
        const rows = await executor<Row[]>`
          delete from lead_contacts where lead_id = any(${[...leadIds]}::uuid[]) returning lead_id
        `;
        return rows.length;
      }),

    expired: (endedBefore, actor, limit = 500) =>
      translated(async () => {
        await authorize(executor, actor, 'lead.manage');
        const rows = await executor<Row[]>`
          select c.lead_id from lead_contacts c
          join leads l on l.id = c.lead_id
          join experiments e on e.id = c.experiment_id
          where l.status <> 'customer' and e.status in ('completed', 'cancelled')
            and e.ended_at < ${endedBefore}
          order by e.ended_at, c.lead_id
          limit ${limit}
        `;
        return rows.map((row) => row['lead_id'] as LeadId);
      }),
  };
}
