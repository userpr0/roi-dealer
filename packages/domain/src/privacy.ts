/**
 * Contact data that must never be stored in Evidence (D-014 п.6, data minimization).
 * The evidence engine redacts more (profile links, handles, ids) before saving; these patterns
 * are the invariant every stored excerpt satisfies, whoever writes it.
 */

/** An email address. The database checks the same pattern (migration 0005). */
export const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * A phone number written with separators: North American `(555) 123-4567`, `555.123.4567`,
 * `+1 555 123 4567`, or international with a leading `+`. Bare digit runs are not matched:
 * they are usually ids, amounts or years.
 */
export const PHONE_PATTERN =
  /(?<![\w+])(?:(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}|\+\d{1,3}(?:[\s.-]?\d{2,4}){2,4})(?!\w)/g;

/** True when `text` contains an email address or a phone number. */
export function containsContactData(text: string): boolean {
  return [EMAIL_PATTERN, PHONE_PATTERN].some((pattern) => new RegExp(pattern.source).test(text));
}
