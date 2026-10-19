import { z } from 'zod';

/*
 * The sign-up form of a test page (PHASE 20): an email, the consent box and a trap field that
 * people do not see and robots fill in. Parsed from the urlencoded body; nothing is logged.
 */

export const LEAD_FORM_FIELDS = {
  email: 'email',
  consent: 'consent',
  /** Hidden from people by CSS; a filled trap is a robot. */
  trap: 'website',
} as const;

/** The value of the consent box when it is ticked. */
export const CONSENT_VALUE = 'yes';
export const MAX_EMAIL_LENGTH = 254;
/** The longest form body the api reads. */
export const MAX_FORM_BYTES = 4_096;

/** The same rule as the database's CHECK on `lead_contacts.email`. */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const emailSchema = z.email().max(MAX_EMAIL_LENGTH);

export type LeadForm =
  | { readonly kind: 'valid'; readonly email: string }
  | { readonly kind: 'invalid'; readonly reason: 'email' | 'consent' }
  | { readonly kind: 'trap' };

/** The email in the form the database keeps: trimmed, lower case; `undefined` if not valid. */
export function normalizeEmail(raw: string): string | undefined {
  const email = raw.trim().toLowerCase();
  if (email.length < 6 || !EMAIL_SHAPE.test(email)) return undefined;
  return emailSchema.safeParse(email).success ? email : undefined;
}

export function parseLeadForm(body: string): LeadForm {
  const form = new URLSearchParams(body.slice(0, MAX_FORM_BYTES));
  if ((form.get(LEAD_FORM_FIELDS.trap) ?? '').trim() !== '') return { kind: 'trap' };
  const email = normalizeEmail(form.get(LEAD_FORM_FIELDS.email) ?? '');
  if (email === undefined) return { kind: 'invalid', reason: 'email' };
  if (form.get(LEAD_FORM_FIELDS.consent) !== CONSENT_VALUE) {
    return { kind: 'invalid', reason: 'consent' };
  }
  return { kind: 'valid', email };
}
