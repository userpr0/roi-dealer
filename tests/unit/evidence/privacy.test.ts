import { describe, expect, it } from 'vitest';
import { containsContactData } from '@roi-dealer/domain';
import { redactionTotal, redactPersonalData } from '@roi-dealer/evidence';

describe('redactPersonalData (D-014 п.6)', () => {
  it.each([
    ['email', 'Write me at jane.doe+hn@example.co.uk please', 'Write me at [email] please'],
    ['phone', 'Call (555) 123-4567 or +1 555 123 4567', 'Call [phone] or [phone]'],
    ['phone', 'International: +44 20 7946 0958.', 'International: [phone].'],
    ['ssn', 'My SSN 123-45-6789 leaked', 'My SSN [ssn] leaked'],
    ['card', 'Card 4111 1111 1111 1111 was charged twice', 'Card [card] was charged twice'],
    ['ip', 'Server at 192.168.10.25 is down', 'Server at [ip] is down'],
    ['handle', 'Thanks @dang and @pg_founder!', 'Thanks [handle] and [handle]!'],
    [
      'profile',
      'See https://news.ycombinator.com/user?id=throwaway123 and twitter.com/janedoe',
      'See [profile] and [profile]',
    ],
    [
      'profile',
      'Me: linkedin.com/in/jane-doe-123, github.com/janedoe/project, bsky.app/profile/jane.bsky.social',
      'Me: [profile], [profile], [profile]',
    ],
  ])('replaces %s', (kind, text, expected) => {
    const redacted = redactPersonalData(text);
    expect(redacted.text).toBe(expected);
    expect(redacted.counts[kind as keyof typeof redacted.counts]).toBeGreaterThan(0);
    expect(containsContactData(redacted.text)).toBe(false);
  });

  it('keeps ordinary text, amounts, dates, years and ids', () => {
    const text =
      'We pay $1,200,000 a year since 2019-03-15 for 3 tools; ticket 4111111111111112 is open, ' +
      'version 2.4 shipped, Ask HN: how do you invoice 30 clients?';
    const redacted = redactPersonalData(text);
    expect(redacted.text).toBe(text);
    expect(redactionTotal(redacted)).toBe(0);
  });

  it('counts every replaced fragment', () => {
    const redacted = redactPersonalData('a@b.io, c@d.io and 555-123-4567');
    expect(redacted.counts).toMatchObject({ email: 2, phone: 1 });
    expect(redactionTotal(redacted)).toBe(3);
  });
});
