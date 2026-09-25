import { describe, expect, it } from 'vitest';
import {
  assertAutomationRunning,
  AUTOMATION_CONTROL_ID,
  createSystemControl,
  pauseSystem,
  resumeSystem,
  systemControlIdSchema,
  systemControlSchema,
  type SystemControl,
} from '@roi-dealer/domain';
import { AGENT, createCtx, ctx, MEMBER, OWNER, SYSTEM } from '../../support/domain.js';

function control(): SystemControl {
  return createSystemControl('automation', createCtx(systemControlIdSchema, SYSTEM, 0));
}

describe('SystemControl (kill switch, D-002)', () => {
  it('starts running without a reason', () => {
    const created = control();
    expect(created).toMatchObject({ key: 'automation', status: 'running', version: 1 });
    expect(created).not.toHaveProperty('reason');
    expect(() => assertAutomationRunning(created)).not.toThrow();
  });

  it('has a well-known id for the automation switch', () => {
    expect(systemControlIdSchema.safeParse(AUTOMATION_CONTROL_ID).success).toBe(true);
  });

  it('is paused by the owner with a reason and stops automations', () => {
    const paused = pauseSystem(control(), 'Проверяю расходы', ctx(OWNER, 5));
    expect(paused).toMatchObject({
      status: 'paused',
      reason: 'Проверяю расходы',
      version: 2,
      updatedAt: ctx(OWNER, 5).at,
    });
    expect(() => assertAutomationRunning(paused)).toThrow(
      expect.objectContaining({ code: 'automation_paused', details: { control: 'automation' } }),
    );
  });

  it('may be paused by the system (future spend anomaly auto-pause)', () => {
    expect(pauseSystem(control(), 'Spend anomaly', ctx(SYSTEM, 1)).status).toBe('paused');
  });

  it.each([AGENT, MEMBER])('is never paused by a $type', (actor) => {
    expect(() => pauseSystem(control(), 'Stop', ctx(actor, 1))).toThrow(
      expect.objectContaining({ code: 'owner_required' }),
    );
  });

  it('is resumed only by the owner, and the reason is cleared', () => {
    const paused = pauseSystem(control(), 'Stop', ctx(OWNER, 1));
    for (const actor of [SYSTEM, AGENT, MEMBER]) {
      expect(() => resumeSystem(paused, ctx(actor, 2))).toThrow(
        expect.objectContaining({ code: 'owner_required' }),
      );
    }
    const resumed = resumeSystem(paused, ctx(OWNER, 2));
    expect(resumed).toMatchObject({ status: 'running', version: 3 });
    expect(resumed).not.toHaveProperty('reason');
    expect(() => assertAutomationRunning(resumed)).not.toThrow();
  });

  it('allows only running ⇄ paused', () => {
    expect(() => resumeSystem(control(), ctx(OWNER, 1))).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
    const paused = pauseSystem(control(), 'Stop', ctx(OWNER, 1));
    expect(() => pauseSystem(paused, 'Again', ctx(OWNER, 2))).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it('keeps the reason exactly while paused', () => {
    expect(() => pauseSystem(control(), '   ', ctx(OWNER, 1))).toThrow(
      expect.objectContaining({ code: 'invariant_violation' }),
    );
    const running = control();
    expect(systemControlSchema.safeParse({ ...running, reason: 'x' }).success).toBe(false);
    const paused = pauseSystem(running, 'Stop', ctx(OWNER, 1));
    const { reason: _reason, ...withoutReason } = paused;
    expect(systemControlSchema.safeParse(withoutReason).success).toBe(false);
  });
});
