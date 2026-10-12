import { describe, expect, it } from 'vitest';
import {
  actorLabel,
  describeEvent,
  eventLine,
  isHistoryEvent,
  shorten,
} from '@roi-dealer/command-center';
import { storedEventSchema, type StoredEvent } from '@roi-dealer/events';
import { AGENT, OWNER, SYSTEM } from '../../support/domain.js';

const ID = '0190c5a6-7b8e-7c3d-9f00-123456789abc';

function event(
  type: string,
  version: number,
  snapshot: Record<string, unknown>,
  previousStatus?: string,
): StoredEvent {
  return storedEventSchema.parse({
    position: 1,
    id: '0190c5a6-7b8e-7c3d-9f00-000000000001',
    type,
    aggregate: { type: type.split('.')[0], id: ID },
    aggregateVersion: version,
    occurredAt: '2026-09-25T11:05:00.000Z',
    recordedAt: '2026-09-25T11:05:00.100Z',
    actor: OWNER,
    payload: { snapshot, ...(previousStatus === undefined ? {} : { previousStatus }) },
  });
}

describe('event descriptions', () => {
  it('describe creations with the entity, its name, money and status', () => {
    expect(
      describeEvent(
        event('approval_request.created', 1, {
          title: 'Buy a domain',
          amount: { currency: 'USD', amountCents: 3_500 },
          status: 'pending',
        }),
      ),
    ).toBe('➕ Запрос одобрения «Buy a domain» · $35.00 · pending');
    expect(
      describeEvent(event('decision.created', 1, { outcome: 'more_research', rationale: 'x' })),
    ).toBe('➕ Решение more_research');
  });

  it('describe status changes', () => {
    expect(
      describeEvent(
        event(
          'opportunity.updated',
          2,
          { title: 'CRM for dentists', status: 'under_review' },
          'draft',
        ),
      ),
    ).toBe('Возможность «CRM for dentists»: draft → under_review');
    expect(
      describeEvent(
        event('system_control.updated', 2, { status: 'paused', reason: 'Проверка' }, 'running'),
      ),
    ).toBe('Стоп-кран: running → paused («Проверка»)');
    expect(describeEvent(event('signal.updated', 3, { title: 'S', status: 'new' }, 'new'))).toBe(
      'Сигнал «S»: изменение (new)',
    );
  });

  it('mark reversals of costs', () => {
    expect(
      describeEvent(
        event('cost_entry.created', 1, {
          description: 'OpenAI API',
          amount: { currency: 'USD', amountCents: 1_200 },
          reversalOf: ID,
        }),
      ),
    ).toBe('➕ Расход сторно $12.00 «OpenAI API»');
  });

  it('build one bounded line with Kyiv time and the actor', () => {
    const line = eventLine(
      event('pain.created', 1, { title: 'x'.repeat(300), status: 'identified' }),
    );
    expect(line.startsWith('25.09 14:05 · Владелец · ➕ Боль «')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(130);
  });

  it('name actors without their ids for the owner and the system', () => {
    expect([OWNER, SYSTEM, AGENT].map(actorLabel)).toEqual([
      'Владелец',
      'Система',
      'Агент research-agent',
    ]);
  });

  it('shorten text to one line', () => {
    expect(shorten('a\n  b   c', 10)).toBe('a b c');
    expect(shorten('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('isHistoryEvent', () => {
  it('keeps decisions, approvals, costs, the kill switch and experiment milestones', () => {
    expect(isHistoryEvent(event('decision.created', 1, {}))).toBe(true);
    expect(isHistoryEvent(event('approval_request.updated', 2, {}))).toBe(true);
    expect(isHistoryEvent(event('cost_entry.created', 1, {}))).toBe(true);
    expect(isHistoryEvent(event('system_control.updated', 2, {}))).toBe(true);
    expect(isHistoryEvent(event('experiment.updated', 4, { status: 'running' }))).toBe(true);
    expect(isHistoryEvent(event('experiment.updated', 2, { status: 'awaiting_approval' }))).toBe(
      false,
    );
    expect(isHistoryEvent(event('experiment.created', 1, { status: 'planned' }))).toBe(false);
    expect(isHistoryEvent(event('opportunity.updated', 2, { status: 'validating' }))).toBe(false);
  });
});
