/**
 * @roi-dealer/schemas — boundary contracts (PHASE 01).
 *
 * Everything that enters the system from outside (API, Telegram bot, AI agents,
 * integrations) is validated here before it reaches domain factories.
 * Input schemas are strict: unknown keys and server-controlled fields
 * (`id`, `status`, `version`, timestamps, `createdBy`) are rejected.
 */
import { z } from 'zod';
import {
  newApprovalRequestSchema,
  newContributionSchema,
  newCostEntrySchema,
  newDecisionSchema,
  newEvidenceSchema,
  newExperimentSchema,
  newHypothesisSchema,
  newKnowledgeAssetSchema,
  newOpportunitySchema,
  newPainSchema,
  newRewardSchema,
  newSignalSchema,
  newSourceSchema,
  text,
} from '@roi-dealer/domain';

/** Create-command inputs, one per core entity. */
export const createInputSchemas = {
  source: newSourceSchema,
  evidence: newEvidenceSchema,
  signal: newSignalSchema,
  pain: newPainSchema,
  opportunity: newOpportunitySchema,
  decision: newDecisionSchema,
  approvalRequest: newApprovalRequestSchema,
  hypothesis: newHypothesisSchema,
  experiment: newExperimentSchema,
  costEntry: newCostEntrySchema,
  contribution: newContributionSchema,
  reward: newRewardSchema,
  knowledgeAsset: newKnowledgeAssetSchema,
} as const;
export type CreateInputKind = keyof typeof createInputSchemas;

/** The owner's answer to an ApprovalRequest (Telegram buttons, Mini App). */
export const approvalDecisionInputSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  comment: text(1_000).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionInputSchema>;

/** The owner's verdict on a Contribution. */
export const contributionReviewInputSchema = z.strictObject({
  verdict: z.enum(['verify', 'reject']),
  note: text(1_000).optional(),
});
export type ContributionReviewInput = z.infer<typeof contributionReviewInputSchema>;

export interface InputIssue {
  readonly path: string;
  readonly message: string;
}

/** Untrusted input did not match its contract. Contains paths and messages, never values. */
export class InputValidationError extends Error {
  override readonly name = 'InputValidationError';
  readonly issues: readonly InputIssue[];

  constructor(issues: readonly InputIssue[]) {
    super(`Invalid input: ${issues.map((issue) => `${issue.path} (${issue.message})`).join('; ')}`);
    this.issues = issues;
  }
}

export function parseInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new InputValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export const PACKAGE_NAME = '@roi-dealer/schemas';
