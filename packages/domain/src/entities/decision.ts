import { z } from 'zod';
import {
  assertOwner,
  immutableMeta,
  immutableMetaShape,
  parseEntity,
  type CreateContext,
} from '../entity.js';
import {
  decisionIdSchema,
  evidenceIdSchema,
  text,
  uniqueList,
  type DecisionId,
} from '../primitives.js';

/** Decision Engine outcomes (PHASE 12) and post-test decisions (§7.1 Step H). */
export const DECISION_OUTCOMES = [
  'approve',
  'reject',
  'more_research',
  'pause',
  'kill',
  'scale',
  'improve',
  'pivot',
] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

const newDecisionShape = {
  subject: z.strictObject({ type: z.enum(['opportunity', 'experiment']), id: z.uuid() }),
  outcome: z.enum(DECISION_OUTCOMES),
  rationale: text(3_000),
  /** Evidence the owner relied on (may be empty for pure judgement calls). */
  evidenceIds: uniqueList(evidenceIdSchema, { max: 100 }),
};

/** An immutable record of an owner decision — part of the Company Brain history. */
export const newDecisionSchema = z.strictObject(newDecisionShape);
export type NewDecision = z.infer<typeof newDecisionSchema>;

export const decisionSchema = z.object({
  ...newDecisionShape,
  id: decisionIdSchema,
  ...immutableMetaShape,
});
export type Decision = z.infer<typeof decisionSchema>;

/** Only the owner makes decisions; AI may only propose them (§2.3). */
export function createDecision(data: NewDecision, context: CreateContext<DecisionId>): Decision {
  assertOwner(context.actor, 'record decisions');
  return parseEntity(decisionSchema, 'decision', {
    ...data,
    id: context.id,
    ...immutableMeta(context),
  });
}
