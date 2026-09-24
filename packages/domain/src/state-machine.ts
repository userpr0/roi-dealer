import { DomainError } from './errors.js';
import type { EntityType } from './primitives.js';

export interface StateMachine<S extends string> {
  readonly entity: EntityType;
  readonly states: readonly S[];
  canTransition(from: S, to: S): boolean;
  nextStates(from: S): readonly S[];
  isTerminal(state: S): boolean;
  /** Throws `DomainError('invalid_transition')` when `from → to` is not allowed. */
  assertTransition(from: S, to: S): void;
}

/**
 * Declares an entity lifecycle as an explicit transition table.
 * A state with an empty list is terminal.
 */
export function defineStateMachine<const S extends string>(
  entity: EntityType,
  transitions: { readonly [K in S]: readonly S[] },
): StateMachine<S> {
  const states = Object.keys(transitions) as S[];
  const nextStates = (from: S): readonly S[] => transitions[from];

  return {
    entity,
    states,
    nextStates,
    canTransition: (from, to) => nextStates(from).includes(to),
    isTerminal: (state) => nextStates(state).length === 0,
    assertTransition(from, to) {
      if (!nextStates(from).includes(to)) {
        throw new DomainError('invalid_transition', `${entity}: ${from} → ${to} is not allowed`, {
          entity,
          from,
          to,
          allowed: nextStates(from),
        });
      }
    },
  };
}
