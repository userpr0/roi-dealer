/**
 * @roi-dealer/crm — CRM / Outcomes (PHASE 20, D-022): the sign-up form of test pages, leads
 * with their emails kept apart from the history, deletion on request and the retention period.
 */
export {
  CONSENT_VALUE,
  LEAD_FORM_FIELDS,
  MAX_EMAIL_LENGTH,
  MAX_FORM_BYTES,
  normalizeEmail,
  parseLeadForm,
  type LeadForm,
} from './form.js';
export {
  captureLead,
  createLeadRetention,
  eraseContacts,
  forgetEmail,
  LEAD_RETENTION,
  purgeExpiredContacts,
  type LeadRetention,
  type SignUp,
  type SignUpOutcome,
} from './leads.js';

export const PACKAGE_NAME = '@roi-dealer/crm';
