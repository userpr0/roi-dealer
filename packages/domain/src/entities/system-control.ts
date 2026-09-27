import { z } from 'zod';
import {
  mutableMeta,
  mutableMetaShape,
  parseEntity,
  transition,
  type CreateContext,
  type DomainContext,
} from '../entity.js';
import { DomainError } from '../errors.js';
import { systemControlIdSchema, text, type SystemControlId } from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';

/** Switches of the whole system. `automation`: the kill switch of 13b (D-002). */
export const SYSTEM_CONTROL_KEYS = ['automation'] as const;
export type SystemControlKey = (typeof SYSTEM_CONTROL_KEYS)[number];

/** Well-known id of the automation kill switch; the row is created by migration 0003. */
export const AUTOMATION_CONTROL_ID: SystemControlId = systemControlIdSchema.parse(
  '00000000-0000-7000-8000-000000000001',
);

export const SYSTEM_CONTROL_STATUSES = ['running', 'paused'] as const;
export type SystemControlStatus = (typeof SYSTEM_CONTROL_STATUSES)[number];

export const systemControlLifecycle = defineStateMachine<SystemControlStatus>('system_control', {
  running: ['paused'],
  paused: ['running'],
});

export const systemControlSchema = z
  .object({
    id: systemControlIdSchema,
    key: z.enum(SYSTEM_CONTROL_KEYS),
    status: z.enum(SYSTEM_CONTROL_STATUSES),
    /** Why the system was paused; present exactly while paused. */
    reason: text(500).optional(),
    ...mutableMetaShape,
  })
  .refine((control) => (control.status === 'paused') === (control.reason !== undefined), {
    message: 'a paused control has a reason, a running one has none',
    path: ['reason'],
  });
export type SystemControl = z.infer<typeof systemControlSchema>;

export function createSystemControl(
  key: SystemControlKey,
  context: CreateContext<SystemControlId>,
): SystemControl {
  return parseEntity(systemControlSchema, 'system_control', {
    id: context.id,
    key,
    status: 'running',
    ...mutableMeta(context),
  });
}

/**
 * The kill switch. The owner pulls it from the panel; the system may pull it automatically
 * (spend anomaly auto-pause, D-014 п.10). AI agents and integrations may not.
 */
export function pauseSystem(
  control: SystemControl,
  reason: string,
  context: DomainContext,
): SystemControl {
  if (context.actor.type !== 'owner' && context.actor.type !== 'system') {
    throw new DomainError('owner_required', 'Only the owner or the system may pause automation', {
      actor_type: context.actor.type,
    });
  }
  return transition(control, systemControlLifecycle, systemControlSchema, 'paused', context, {
    reason,
  });
}

/** Only the owner resumes (13b plan: resume needs the owner's confirmation). */
export function resumeSystem(control: SystemControl, context: DomainContext): SystemControl {
  if (context.actor.type !== 'owner') {
    throw new DomainError('owner_required', 'Only the owner may resume automation', {
      actor_type: context.actor.type,
    });
  }
  const { reason: _reason, ...withoutReason } = control;
  return transition(withoutReason, systemControlLifecycle, systemControlSchema, 'running', context);
}

/** First step of every automation and automated spend: refuse to work while paused. */
export function assertAutomationRunning(control: SystemControl): void {
  if (control.status === 'paused') {
    throw new DomainError('automation_paused', 'Automation is paused by the kill switch', {
      control: control.key,
    });
  }
}
