/**
 * @roi-dealer/policies — roles and permissions (PHASE 04, constitution §2.3, §2.11).
 *
 * Pure functions: which actor may perform which action, and the access decision that combines
 * the role with the actor's registered identity (Principal). Budgets and configurable approval
 * policies extend this package in PHASE 16.
 */
export {
  assertPermitted,
  decideAccess,
  DENIAL_REASONS,
  ENTITY_WRITE_PERMISSIONS,
  isPermitted,
  PANEL_READS,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  writePermission,
  type AccessDecision,
  type DenialReason,
  type Permission,
  type WriteOperation,
} from './permissions.js';

export const PACKAGE_NAME = '@roi-dealer/policies';
