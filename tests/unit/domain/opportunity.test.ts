import { describe, expect, it } from 'vitest';
import {
  applyOpportunityDecision,
  archiveOpportunity,
  createDecision,
  createOpportunity,
  decisionIdSchema,
  opportunityIdSchema,
  painIdSchema,
  startOpportunityValidation,
  submitOpportunityForReview,
  type Decision,
  type DecisionOutcome,
  type Opportunity,
} from '@roi-dealer/domain';
import { AGENT, at, createCtx, ctx, MEMBER, OWNER, opportunityData } from '../../support/domain.js';

const painId = painIdSchema.parse('0190c5a6-7b8e-7c3d-9f00-123456789abc');

function draft(): Opportunity {
  return createOpportunity(opportunityData([painId]), createCtx(opportunityIdSchema, AGENT));
}

function decide(opportunity: Opportunity, outcome: DecisionOutcome, minutes = 10): Decision {
  return createDecision(
    {
      subject: { type: 'opportunity', id: opportunity.id },
      outcome,
      rationale: 'Owner judgement based on evidence and judges',
      evidenceIds: [],
    },
    createCtx(decisionIdSchema, OWNER, minutes),
  );
}

describe('Opportunity', () => {
  it('is created as a draft with an outcome-first value proposition', () => {
    const opportunity = draft();
    expect(opportunity).toMatchObject({ status: 'draft', version: 1, createdBy: AGENT });
    expect(() =>
      createOpportunity(
        opportunityData([painId], {
          valueProposition: { problem: 'x', change: 'y', measurableResult: '' },
        }),
        createCtx(opportunityIdSchema),
      ),
    ).toThrow(expect.objectContaining({ code: 'invariant_violation' }));
  });

  it('goes through review and is approved only by an owner decision', () => {
    const inReview = submitOpportunityForReview(draft(), ctx(AGENT, 1));
    const decision = decide(inReview, 'approve');

    const approved = applyOpportunityDecision(inReview, decision);

    expect(approved).toMatchObject({
      status: 'approved',
      lastDecisionId: decision.id,
      version: 3,
      updatedAt: at(10),
    });
    expect(inReview.status).toBe('under_review');
  });

  it.each([
    ['reject', 'rejected'],
    ['more_research', 'draft'],
  ] as const)('maps %s to %s', (outcome, status) => {
    const inReview = submitOpportunityForReview(draft(), ctx(AGENT, 1));
    expect(applyOpportunityDecision(inReview, decide(inReview, outcome)).status).toBe(status);
  });

  it('cannot skip the review', () => {
    const opportunity = draft();
    expect(() => applyOpportunityDecision(opportunity, decide(opportunity, 'approve'))).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it('follows SCALE / IMPROVE / PIVOT / KILL after validation', () => {
    const inReview = submitOpportunityForReview(draft(), ctx(AGENT, 1));
    const approved = applyOpportunityDecision(inReview, decide(inReview, 'approve', 2));
    const validating = startOpportunityValidation(approved, ctx(AGENT, 3));

    const improved = applyOpportunityDecision(validating, decide(validating, 'improve', 4));
    expect(improved).toMatchObject({ status: 'validating', version: validating.version + 1 });

    expect(applyOpportunityDecision(validating, decide(validating, 'scale')).status).toBe(
      'scaling',
    );
    expect(applyOpportunityDecision(validating, decide(validating, 'pivot')).status).toBe('killed');
    expect(applyOpportunityDecision(validating, decide(validating, 'pause')).status).toBe('paused');
    const killed = applyOpportunityDecision(validating, decide(validating, 'kill'));
    expect(() => applyOpportunityDecision(killed, decide(killed, 'approve'))).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it('rejects a decision about another subject', () => {
    const one = submitOpportunityForReview(draft(), ctx());
    const other = submitOpportunityForReview(draft(), ctx());
    expect(() => applyOpportunityDecision(one, decide(other, 'approve'))).toThrow(
      expect.objectContaining({ code: 'invariant_violation' }),
    );
  });

  it('can be archived only as a draft', () => {
    expect(archiveOpportunity(draft(), ctx()).status).toBe('archived');
    expect(() => archiveOpportunity(submitOpportunityForReview(draft(), ctx()), ctx())).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });
});

describe('Decision', () => {
  it.each([AGENT, MEMBER])(
    'cannot be made by $type actors (AI proposes, owner decides)',
    (actor) => {
      const opportunity = draft();
      expect(() =>
        createDecision(
          {
            subject: { type: 'opportunity', id: opportunity.id },
            outcome: 'approve',
            rationale: 'Looks promising',
            evidenceIds: [],
          },
          createCtx(decisionIdSchema, actor),
        ),
      ).toThrow(expect.objectContaining({ code: 'owner_required' }));
    },
  );

  it('is an immutable record', () => {
    const decision = decide(draft(), 'reject');
    expect(decision).not.toHaveProperty('version');
    expect(decision.createdBy).toEqual(OWNER);
  });
});
