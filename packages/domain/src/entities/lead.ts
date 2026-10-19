import { z } from 'zod';
import {
  assertOwner,
  mutableMeta,
  mutableMetaShape,
  parseEntity,
  transition,
  type CreateContext,
  type DomainContext,
} from '../entity.js';
import { DomainError } from '../errors.js';
import {
  experimentIdSchema,
  hypothesisIdSchema,
  leadIdSchema,
  mediaAssetIdSchema,
  opportunityIdSchema,
  text,
  timestampSchema,
  type LeadId,
} from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';

/*
 * CRM (PHASE 20, D-022): a person who left their email on a test's page with consent. The lead
 * holds no personal data — the email lives in a separate table that is deleted for real on
 * request or after the retention period. Only the owner moves a lead and records the
 * customer's outcome (§2.3).
 */

export const LEAD_STATUSES = ['new', 'contacted', 'customer', 'lost'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const leadLifecycle = defineStateMachine<LeadStatus>('lead', {
  new: ['contacted', 'customer', 'lost'],
  contacted: ['customer', 'lost'],
  customer: [],
  lost: [],
});

/** Whether the customer got the promised result (Customer Outcome, §2.17). */
export const CUSTOMER_OUTCOMES = ['achieved', 'partial', 'not_achieved'] as const;
export type CustomerOutcome = (typeof CUSTOMER_OUTCOMES)[number];

/** Contacts of leads that did not become customers are erased this long after the test. */
export const LEAD_RETENTION_DAYS = 180;

const newLeadShape = {
  experimentId: experimentIdSchema,
  hypothesisId: hypothesisIdSchema,
  opportunityId: opportunityIdSchema,
  /** The released page the person signed up on. */
  mediaAssetId: mediaAssetIdSchema,
  channel: text(100),
  utmSource: text(100).optional(),
  /** When the person ticked the consent box (UTC). */
  consentAt: timestampSchema,
};

export const newLeadSchema = z.strictObject(newLeadShape);
export type NewLead = z.infer<typeof newLeadSchema>;

export const leadSchema = z
  .object({
    ...newLeadShape,
    id: leadIdSchema,
    status: z.enum(LEAD_STATUSES),
    outcome: z.enum(CUSTOMER_OUTCOMES).optional(),
    outcomeAt: timestampSchema.optional(),
    /** When the email was deleted (request or retention); the lead stays for the numbers. */
    contactErasedAt: timestampSchema.optional(),
    ...mutableMetaShape,
  })
  .refine((lead) => (lead.outcome === undefined) === (lead.outcomeAt === undefined), {
    message: 'an outcome needs its time',
    path: ['outcomeAt'],
  })
  .refine((lead) => lead.outcome === undefined || lead.status === 'customer', {
    message: 'only a customer has an outcome',
    path: ['outcome'],
  });
export type Lead = z.infer<typeof leadSchema>;

/** A sign-up from a test's page (PHASE 20): the page counter records it with the consent. */
export function createLead(data: NewLead, context: CreateContext<LeadId>): Lead {
  return parseEntity(leadSchema, 'lead', {
    ...data,
    id: context.id,
    status: 'new',
    ...mutableMeta(context),
  });
}

/** The owner's work with the lead: contacted, customer or lost. */
export function changeLeadStatus(
  lead: Lead,
  to: Exclude<LeadStatus, 'new'>,
  context: DomainContext,
): Lead {
  assertOwner(context.actor, 'change a lead');
  return transition(lead, leadLifecycle, leadSchema, to, context);
}

/** The customer's outcome, set or corrected by the owner. */
export function recordCustomerOutcome(
  lead: Lead,
  outcome: CustomerOutcome,
  context: DomainContext,
): Lead {
  assertOwner(context.actor, 'record a customer outcome');
  if (lead.status !== 'customer') {
    throw new DomainError('invalid_transition', 'Only a customer has an outcome', {
      lead_status: lead.status,
    });
  }
  return parseEntity(leadSchema, 'lead', {
    ...lead,
    outcome,
    outcomeAt: context.at,
    updatedAt: context.at,
    version: lead.version + 1,
  });
}

/**
 * Marks the lead's email as deleted (a person's request through the owner, or the retention
 * period through the system). The caller deletes the contact in the same transaction.
 */
export function eraseLeadContact(lead: Lead, context: DomainContext): Lead {
  if (context.actor.type !== 'owner' && context.actor.type !== 'system') {
    throw new DomainError('owner_required', 'Only the owner or the system erases contacts', {
      actor_type: context.actor.type,
    });
  }
  if (lead.contactErasedAt !== undefined) {
    throw new DomainError('invalid_transition', 'The contact is already erased', {});
  }
  return parseEntity(leadSchema, 'lead', {
    ...lead,
    contactErasedAt: context.at,
    updatedAt: context.at,
    version: lead.version + 1,
  });
}
