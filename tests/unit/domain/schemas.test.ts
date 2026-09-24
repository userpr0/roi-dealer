import { describe, expect, it } from 'vitest';
import {
  approvalDecisionInputSchema,
  createInputSchemas,
  InputValidationError,
  parseInput,
} from '@roi-dealer/schemas';
import { opportunityIdSchema } from '@roi-dealer/domain';
import { hypothesisData, sourceData } from '../../support/domain.js';

describe('boundary contracts', () => {
  it('has a strict create schema for every core entity', () => {
    expect(Object.keys(createInputSchemas).sort()).toEqual([
      'approvalRequest',
      'contribution',
      'costEntry',
      'decision',
      'evidence',
      'experiment',
      'hypothesis',
      'knowledgeAsset',
      'opportunity',
      'pain',
      'reward',
      'signal',
      'source',
    ]);
  });

  it.each(['id', 'status', 'version', 'createdAt', 'createdBy', 'updatedAt'])(
    'rejects the server-controlled field %s',
    (field) => {
      expect(() =>
        parseInput(createInputSchemas.source, { ...sourceData(), [field]: 'forged' }),
      ).toThrow(InputValidationError);
    },
  );

  it('rejects unknown keys in nested value objects', () => {
    const opportunityId = opportunityIdSchema.parse('0190c5a6-7b8e-7c3d-9f00-123456789abc');
    const raw = JSON.parse(JSON.stringify(hypothesisData(opportunityId))) as Record<
      string,
      unknown
    >;
    raw['budget'] = { currency: 'USD', amountCents: 1_000, discount: 50 };

    expect(() => parseInput(createInputSchemas.hypothesis, raw)).toThrow(/budget/);
  });

  it('reports paths and messages without echoing values', () => {
    const secret = 'sk-live-should-not-leak';
    try {
      parseInput(createInputSchemas.source, { ...sourceData(), kind: secret, markets: [] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InputValidationError);
      const issues = (error as InputValidationError).issues.map((issue) => issue.path);
      expect(issues).toEqual(expect.arrayContaining(['kind', 'markets']));
      expect(JSON.stringify(error) + String(error)).not.toContain(secret);
    }
  });

  it('parses the owner decision from a button press', () => {
    expect(parseInput(approvalDecisionInputSchema, { decision: 'approve' })).toEqual({
      decision: 'approve',
    });
    expect(() => parseInput(approvalDecisionInputSchema, { decision: 'maybe' })).toThrow(
      InputValidationError,
    );
    expect(() => parseInput(approvalDecisionInputSchema, null)).toThrow(/\(root\)/);
  });
});
