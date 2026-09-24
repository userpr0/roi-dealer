import { z } from 'zod';
import {
  mutableMeta,
  mutableMetaShape,
  parseEntity,
  transition,
  type CreateContext,
  type DomainContext,
} from '../entity.js';
import {
  countryCodeSchema,
  evidenceIdSchema,
  signalIdSchema,
  text,
  titleSchema,
  uniqueList,
  type SignalId,
} from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';

export const SIGNAL_STRENGTHS = ['weak', 'moderate', 'strong'] as const;

export const SIGNAL_STATUSES = ['new', 'triaged', 'promoted', 'dismissed'] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export const signalLifecycle = defineStateMachine<SignalStatus>('signal', {
  new: ['triaged', 'dismissed'],
  triaged: ['promoted', 'dismissed'],
  promoted: [],
  dismissed: [],
});

const newSignalShape = {
  title: titleSchema,
  summary: text(2_000),
  /** Evidence first (§2.5): a signal always rests on at least one piece of evidence. */
  evidenceIds: uniqueList(evidenceIdSchema, { min: 1, max: 100 }),
  markets: uniqueList(countryCodeSchema, { min: 1, max: 50 }),
  strength: z.enum(SIGNAL_STRENGTHS),
};

/** A pattern noticed in evidence that may point to a pain. */
export const newSignalSchema = z.strictObject(newSignalShape);
export type NewSignal = z.infer<typeof newSignalSchema>;

export const signalSchema = z.object({
  ...newSignalShape,
  id: signalIdSchema,
  status: z.enum(SIGNAL_STATUSES),
  ...mutableMetaShape,
});
export type Signal = z.infer<typeof signalSchema>;

export function createSignal(data: NewSignal, context: CreateContext<SignalId>): Signal {
  return parseEntity(signalSchema, 'signal', {
    ...data,
    id: context.id,
    status: 'new',
    ...mutableMeta(context),
  });
}

export function changeSignalStatus(
  signal: Signal,
  to: SignalStatus,
  context: DomainContext,
): Signal {
  return transition(signal, signalLifecycle, signalSchema, to, context);
}
