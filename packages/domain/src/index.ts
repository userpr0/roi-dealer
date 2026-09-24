/**
 * @roi-dealer/domain — core domain of ROI Dealer (PHASE 01).
 *
 * Pure TypeScript + Zod: entities, value objects, lifecycles and invariants.
 * No I/O: persistence (PHASE 02) and events (PHASE 03) build on top of this package.
 * Time and ids are always passed in by the caller.
 */
export { DomainError, type DomainErrorCode, type DomainIssue } from './errors.js';
export * from './primitives.js';
export * from './money.js';
export { defineStateMachine, type StateMachine } from './state-machine.js';
export {
  assertOwner,
  immutableMetaShape,
  mutableMetaShape,
  type CreateContext,
  type DomainContext,
} from './entity.js';

export * from './entities/source.js';
export * from './entities/evidence.js';
export * from './entities/signal.js';
export * from './entities/pain.js';
export * from './entities/opportunity.js';
export * from './entities/decision.js';
export * from './entities/approval.js';
export * from './entities/hypothesis.js';
export * from './entities/experiment.js';
export * from './entities/cost.js';
export * from './entities/reward.js';
export * from './entities/knowledge.js';

export const PACKAGE_NAME = '@roi-dealer/domain';
