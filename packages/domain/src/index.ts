/**
 * @roi-dealer/domain — core domain of ROI Dealer (PHASE 01; SystemControl — 13b; Principal — PHASE 04;
 * SourceSnapshot and the contact data rule of Evidence — PHASE 05).
 *
 * Pure TypeScript + Zod: entities, value objects, lifecycles and invariants.
 * No I/O: persistence (PHASE 02) and events (PHASE 03) build on top of this package.
 * Time and ids are always passed in by the caller.
 */
export { DomainError, type DomainErrorCode, type DomainIssue } from './errors.js';
export * from './primitives.js';
export * from './money.js';
export { containsContactData, EMAIL_PATTERN, PHONE_PATTERN } from './privacy.js';
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
export * from './entities/system-control.js';
export * from './entities/principal.js';
export * from './entities/source-snapshot.js';
export * from './entities/revenue.js';
export * from './ai-budget.js';
export * from './markets.js';
export * from './market-context.js';
export * from './judgement.js';
export * from './decision-engine.js';
export * from './funnel.js';
export * from './economics.js';

export const PACKAGE_NAME = '@roi-dealer/domain';
