import { describe, expect, it } from 'vitest';
import {
  changePainStatus,
  changeSignalStatus,
  changeSourceStatus,
  createEvidence,
  createPain,
  createSignal,
  createSource,
  evidenceIdSchema,
  newEvidenceSchema,
  painIdSchema,
  signalIdSchema,
  sourceIdSchema,
  validatePain,
} from '@roi-dealer/domain';
import {
  AGENT,
  at,
  createCtx,
  ctx,
  evidenceData,
  painData,
  sourceData,
} from '../../support/domain.js';

function twoSourcesWithEvidence() {
  const forum = createSource(sourceData(), createCtx(sourceIdSchema));
  const reviews = createSource(
    sourceData({ kind: 'review_site', name: 'G2 reviews', url: 'https://www.g2.com' }),
    createCtx(sourceIdSchema),
  );
  const first = createEvidence(evidenceData(forum.id), createCtx(evidenceIdSchema, AGENT));
  const second = createEvidence(
    evidenceData(reviews.id, { kind: 'review', excerpt: 'Reconciliation is the worst part.' }),
    createCtx(evidenceIdSchema, AGENT),
  );
  const sameSource = createEvidence(evidenceData(forum.id), createCtx(evidenceIdSchema, AGENT));
  return { forum, reviews, first, second, sameSource };
}

describe('Source', () => {
  it('starts active and moves along its lifecycle', () => {
    const source = createSource(sourceData(), createCtx(sourceIdSchema));
    expect(source).toMatchObject({ status: 'active', version: 1 });

    const paused = changeSourceStatus(source, 'paused', ctx(AGENT, 5));
    expect(paused).toMatchObject({ status: 'paused', version: 2, updatedAt: at(5) });
    expect(source.status).toBe('active');

    const retired = changeSourceStatus(paused, 'retired', ctx(AGENT, 6));
    expect(() => changeSourceStatus(retired, 'active', ctx())).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it('rejects invalid data with invariant_violation and field paths', () => {
    expect(() => createSource(sourceData({ markets: [] }), createCtx(sourceIdSchema))).toThrow(
      expect.objectContaining({ code: 'invariant_violation' }),
    );
  });
});

describe('Evidence', () => {
  it('is immutable data captured from a source', () => {
    const { first } = twoSourcesWithEvidence();
    expect(first).not.toHaveProperty('status');
    expect(first).not.toHaveProperty('version');
    expect(first.createdBy).toEqual(AGENT);
  });

  it('cannot be observed after it was recorded', () => {
    const source = createSource(sourceData(), createCtx(sourceIdSchema));
    expect(() =>
      createEvidence(
        evidenceData(source.id, { observedAt: at(10) }),
        createCtx(evidenceIdSchema, AGENT, 0),
      ),
    ).toThrow(expect.objectContaining({ code: 'invariant_violation' }));
  });

  it('rejects unknown and server-controlled fields in input', () => {
    const source = createSource(sourceData(), createCtx(sourceIdSchema));
    expect(newEvidenceSchema.safeParse({ ...evidenceData(source.id), id: 'x' }).success).toBe(
      false,
    );
    expect(newEvidenceSchema.safeParse({ ...evidenceData(source.id), trust: 'high' }).success).toBe(
      false,
    );
  });
});

describe('Signal', () => {
  it('requires evidence (evidence first)', () => {
    const { first } = twoSourcesWithEvidence();
    const data = {
      title: 'Agencies complain about reconciliation',
      summary: 'Repeated complaints in forums and reviews',
      evidenceIds: [first.id],
      markets: ['US'],
      strength: 'moderate' as const,
    };
    const signal = createSignal(data, createCtx(signalIdSchema, AGENT));
    expect(signal.status).toBe('new');
    expect(() => createSignal({ ...data, evidenceIds: [] }, createCtx(signalIdSchema))).toThrow(
      expect.objectContaining({ code: 'invariant_violation' }),
    );

    const promoted = changeSignalStatus(
      changeSignalStatus(signal, 'triaged', ctx(AGENT, 1)),
      'promoted',
      ctx(AGENT, 2),
    );
    expect(promoted.status).toBe('promoted');
    expect(() => changeSignalStatus(signal, 'promoted', ctx())).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });
});

describe('Pain', () => {
  it('validates only with evidence from at least two sources', () => {
    const { first, second, sameSource } = twoSourcesWithEvidence();

    const weak = createPain(painData([first.id, sameSource.id]), createCtx(painIdSchema, AGENT));
    expect(() => validatePain(weak, [first, sameSource], ctx())).toThrow(
      expect.objectContaining({
        code: 'evidence_required',
        details: { required_sources: 2, found_sources: 1 },
      }),
    );

    const strong = createPain(painData([first.id, second.id]), createCtx(painIdSchema, AGENT));
    expect(validatePain(strong, [first, second], ctx(AGENT, 1)).status).toBe('validated');
  });

  it('requires every referenced evidence item to be provided', () => {
    const { first, second } = twoSourcesWithEvidence();
    const pain = createPain(painData([first.id, second.id]), createCtx(painIdSchema));
    expect(() => validatePain(pain, [first], ctx())).toThrow(
      expect.objectContaining({ code: 'evidence_required', details: { missing: [second.id] } }),
    );
  });

  it('can be rejected or archived', () => {
    const { first } = twoSourcesWithEvidence();
    const pain = createPain(painData([first.id]), createCtx(painIdSchema));
    expect(changePainStatus(pain, 'rejected', ctx()).status).toBe('rejected');
    expect(changePainStatus(pain, 'archived', ctx()).status).toBe('archived');
    expect(() => createPain(painData([]), createCtx(painIdSchema))).toThrow(
      expect.objectContaining({ code: 'invariant_violation' }),
    );
  });
});
