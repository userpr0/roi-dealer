export type DomainErrorCode =
  /** The requested status change is not allowed by the entity lifecycle. */
  | 'invalid_transition'
  /** Only the owner may perform this action (human gate, constitution §2.3, §2.7). */
  | 'owner_required'
  /** The action needs more supporting evidence (evidence first, §2.5). */
  | 'evidence_required'
  /** The action needs an approved ApprovalRequest that matches it. */
  | 'approval_required'
  /** The ApprovalRequest can no longer be resolved. */
  | 'approval_expired'
  /** The data breaks an entity invariant or schema. */
  | 'invariant_violation'
  /** The kill switch is on: automations and automated spend must not run (13b). */
  | 'automation_paused';

export interface DomainIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Rejection of a state change by domain rules. Carries a stable `code` for callers
 * (API, bot, workflows) and never includes raw field values.
 */
export class DomainError extends Error {
  override readonly name = 'DomainError';
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
