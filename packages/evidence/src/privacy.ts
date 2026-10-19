import { containsContactData, EMAIL_PATTERN, PHONE_PATTERN } from '@roi-dealer/domain';

/*
 * Redaction of personal data before Evidence is stored (D-014 п.6). We keep what a pain or
 * pattern needs — the words — and drop what identifies or reaches a person.
 * Names in free text are a residual risk: finding them reliably needs AI (PHASE 09).
 */

export const REDACTION_KINDS = [
  'profile',
  'email',
  'ssn',
  'card',
  'phone',
  'ip',
  'handle',
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

export interface Redacted {
  readonly text: string;
  /** How many fragments of each kind were replaced. */
  readonly counts: Readonly<Record<RedactionKind, number>>;
}

/** Links to a person's profile on social and community sites, with or without a scheme. */
const PROFILE_PATTERN = new RegExp(
  String.raw`(?<![\w.@/])(?:https?://)?(?:www\.|m\.|mobile\.)?(?:` +
    [
      String.raw`news\.ycombinator\.com/(?:user|submitted|threads)\?id=[\w-]+`,
      String.raw`(?:twitter|x)\.com/@?\w{1,30}`,
      String.raw`linkedin\.com/(?:in|pub)/[\w%-]+`,
      String.raw`(?:facebook|fb|instagram|threads)\.com/[\w.]+`,
      String.raw`tiktok\.com/@[\w.]+`,
      String.raw`t\.me/\w+`,
      String.raw`reddit\.com/u(?:ser)?/[\w-]+`,
      String.raw`github\.com/[A-Za-z0-9-]+`,
      String.raw`bsky\.app/profile/[\w.:-]+`,
    ].join('|') +
    // The rest of the link, without trailing punctuation of the sentence.
    String.raw`)(?:[^\s)\]>"',;]*[^\s)\]>"',;.!?:])?`,
  'gi',
);

const SSN_PATTERN = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g;
/** 13–19 digits, optionally grouped by spaces or dashes; confirmed with the Luhn checksum. */
const CARD_PATTERN = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
const IPV4_PATTERN =
  /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g;
/** `@name` mentions; emails are replaced before, so no `@` of an address is left. */
const HANDLE_PATTERN = /(?<![\w@.])@[A-Za-z0-9_]{2,30}(?![\w@])/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

const RULES: readonly {
  readonly kind: RedactionKind;
  readonly pattern: RegExp;
  readonly accept?: (match: string) => boolean;
}[] = [
  { kind: 'profile', pattern: PROFILE_PATTERN },
  { kind: 'email', pattern: EMAIL_PATTERN },
  { kind: 'ssn', pattern: SSN_PATTERN },
  { kind: 'card', pattern: CARD_PATTERN, accept: (match) => luhnValid(match.replace(/\D/g, '')) },
  { kind: 'phone', pattern: PHONE_PATTERN },
  { kind: 'ip', pattern: IPV4_PATTERN },
  { kind: 'handle', pattern: HANDLE_PATTERN },
];

/** Replaces personal data with `[profile]`, `[email]`, `[ssn]`, `[card]`, `[phone]`, `[ip]`, `[handle]`. */
export function redactPersonalData(text: string): Redacted {
  const counts = Object.fromEntries(REDACTION_KINDS.map((kind) => [kind, 0])) as Record<
    RedactionKind,
    number
  >;
  let result = text;
  for (const rule of RULES) {
    result = result.replace(new RegExp(rule.pattern.source, rule.pattern.flags), (match) => {
      if (rule.accept !== undefined && !rule.accept(match)) return match;
      counts[rule.kind] += 1;
      return `[${rule.kind}]`;
    });
  }
  // The domain invariant (no email, no phone) must hold for whatever the rules left.
  if (containsContactData(result)) {
    throw new Error('redaction left contact data in the text');
  }
  return { text: result, counts };
}

/** Total number of replaced fragments. */
export function redactionTotal(redacted: Redacted): number {
  return REDACTION_KINDS.reduce((sum, kind) => sum + redacted.counts[kind], 0);
}
