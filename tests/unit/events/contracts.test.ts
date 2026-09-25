import { describe, expect, it } from 'vitest';
import { ENTITY_TYPES } from '@roi-dealer/domain';
import {
  APPEND_ONLY_ENTITY_TYPES,
  correlationIdSchema,
  entityEventType,
  EVENT_TYPES,
  idempotencyKeySchema,
  newEventSchema,
  VERSIONED_ENTITY_TYPES,
} from '@roi-dealer/events';
import { uuidv7 } from '@roi-dealer/shared';
import { at, OWNER } from '../../support/domain.js';

const event = (overrides: Record<string, unknown> = {}) => ({
  id: uuidv7(),
  type: 'opportunity.updated',
  aggregate: { type: 'opportunity', id: uuidv7() },
  aggregateVersion: 2,
  occurredAt: at(1),
  actor: OWNER,
  payload: { snapshot: { status: 'approved' }, previousStatus: 'under_review' },
  ...overrides,
});

describe('event types', () => {
  it('cover creation of every entity and updates of versioned ones', () => {
    expect(APPEND_ONLY_ENTITY_TYPES).toEqual([
      'evidence',
      'decision',
      'cost_entry',
      'knowledge_asset',
    ]);
    expect(VERSIONED_ENTITY_TYPES).toHaveLength(
      ENTITY_TYPES.length - APPEND_ONLY_ENTITY_TYPES.length,
    );
    expect(EVENT_TYPES).toHaveLength(13 + 9);
    expect(EVENT_TYPES).toContain('approval_request.updated');
    expect(EVENT_TYPES).not.toContain('evidence.updated');
  });

  it('are built from the entity type and the kind of change', () => {
    expect(entityEventType('cost_entry', 'created')).toBe('cost_entry.created');
    expect(() => entityEventType('decision', 'updated')).toThrow();
  });
});

describe('newEventSchema', () => {
  it('accepts a well-formed event', () => {
    expect(newEventSchema.safeParse(event()).success).toBe(true);
    expect(newEventSchema.safeParse(event({ correlationId: 'tg-update-42' })).success).toBe(true);
  });

  it.each([
    ['a type of another entity', { type: 'signal.updated' }],
    ['a creation at version 2', { type: 'opportunity.created' }],
    ['an update at version 1', { aggregateVersion: 1 }],
    ['a local time instead of UTC', { occurredAt: '2026-10-01T12:00:00+03:00' }],
    ['an unknown field', { extra: true }],
    ['a payload without snapshot', { payload: { previousStatus: 'draft' } }],
  ])('rejects %s', (_case, overrides) => {
    expect(newEventSchema.safeParse(event(overrides)).success).toBe(false);
  });
});

describe('correlation ids and idempotency keys', () => {
  it.each(['tg-update-123', 'req.7f3a:1', 'a'.repeat(128)])(
    'accept the correlation id %s',
    (id) => {
      expect(correlationIdSchema.safeParse(id).success).toBe(true);
    },
  );

  it.each(['', 'has space', 'a'.repeat(129), 'line\nbreak'])(
    'reject the correlation id %j',
    (id) => {
      expect(correlationIdSchema.safeParse(id).success).toBe(false);
    },
  );

  it('bound idempotency keys to a safe charset and 200 characters', () => {
    expect(idempotencyKeySchema.safeParse('tg-callback-9f2c:approve').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('a'.repeat(201)).success).toBe(false);
    expect(idempotencyKeySchema.safeParse('key;drop').success).toBe(false);
  });
});
