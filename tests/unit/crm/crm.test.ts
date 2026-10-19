import { describe, expect, it } from 'vitest';
import { normalizeEmail, parseLeadForm } from '@roi-dealer/crm';
import {
  changeLeadStatus,
  createLead,
  eraseLeadContact,
  experimentIdSchema,
  hypothesisIdSchema,
  leadIdSchema,
  mediaAssetIdSchema,
  opportunityIdSchema,
  recordCustomerOutcome,
} from '@roi-dealer/domain';
import { createSubmissionLimiter } from '@roi-dealer/site';
import { at, createCtx, ctx, INTEGRATION, OWNER, SYSTEM } from '../../support/domain.js';

describe('the sign-up form (PHASE 20)', () => {
  it('keeps a valid email in lower case and asks for the consent', () => {
    expect(parseLeadForm('email=%20Anna%40Example.ORG%20&consent=yes')).toEqual({
      kind: 'valid',
      email: 'anna@example.org',
    });
    expect(parseLeadForm('email=anna%40example.org')).toEqual({
      kind: 'invalid',
      reason: 'consent',
    });
    expect(parseLeadForm('email=anna%40example.org&consent=on')).toEqual({
      kind: 'invalid',
      reason: 'consent',
    });
    for (const email of ['', 'anna', 'anna@', '@example.org', 'a b@example.org', 'anna@example']) {
      expect(parseLeadForm(`email=${encodeURIComponent(email)}&consent=yes`)).toEqual({
        kind: 'invalid',
        reason: 'email',
      });
    }
    expect(normalizeEmail(`${'a'.repeat(250)}@example.org`)).toBeUndefined();
  });

  it('treats a filled trap field as a robot', () => {
    expect(parseLeadForm('email=anna%40example.org&consent=yes&website=x')).toEqual({
      kind: 'trap',
    });
  });

  it('limits submissions per visitor an hour and per minute', () => {
    let clock = 0;
    const limiter = createSubmissionLimiter({
      perVisitorPerHour: 2,
      perMinute: 3,
      now: () => clock,
    });
    expect(limiter.allow('203.0.113.1')).toBe(true);
    expect(limiter.allow('203.0.113.1')).toBe(true);
    expect(limiter.allow('203.0.113.1')).toBe(false);
    expect(limiter.allow('203.0.113.2')).toBe(true);
    expect(limiter.allow('203.0.113.3')).toBe(false);
    clock += 61_000;
    expect(limiter.allow('203.0.113.3')).toBe(true);
    clock += 3_600_000;
    expect(limiter.allow('203.0.113.1')).toBe(true);
  });
});

describe('Lead (PHASE 20)', () => {
  const lead = createLead(
    {
      experimentId: experimentIdSchema.parse('0192f4c2-1111-7000-8000-000000000001'),
      hypothesisId: hypothesisIdSchema.parse('0192f4c2-1111-7000-8000-000000000002'),
      opportunityId: opportunityIdSchema.parse('0192f4c2-1111-7000-8000-000000000003'),
      mediaAssetId: mediaAssetIdSchema.parse('0192f4c2-1111-7000-8000-000000000004'),
      channel: 'Reddit ads',
      utmSource: 'reddit',
      consentAt: at(0),
    },
    createCtx(leadIdSchema, INTEGRATION, 0),
  );

  it('starts new; only the owner moves it', () => {
    expect(lead).toMatchObject({ status: 'new', version: 1 });
    expect(() => changeLeadStatus(lead, 'contacted', ctx(INTEGRATION, 1))).toThrow(/owner/i);
    const contacted = changeLeadStatus(lead, 'contacted', ctx(OWNER, 1));
    expect(changeLeadStatus(contacted, 'customer', ctx(OWNER, 2)).status).toBe('customer');
    const lost = changeLeadStatus(contacted, 'lost', ctx(OWNER, 2));
    expect(() => changeLeadStatus(lost, 'customer', ctx(OWNER, 3))).toThrow();
  });

  it('records an outcome only for a customer', () => {
    expect(() => recordCustomerOutcome(lead, 'achieved', ctx(OWNER, 1))).toThrow(/customer/);
    const customer = changeLeadStatus(lead, 'customer', ctx(OWNER, 1));
    expect(() => recordCustomerOutcome(customer, 'achieved', ctx(INTEGRATION, 2))).toThrow(
      /owner/i,
    );
    expect(recordCustomerOutcome(customer, 'partial', ctx(OWNER, 2))).toMatchObject({
      outcome: 'partial',
      outcomeAt: at(2),
      version: 3,
    });
  });

  it('erases the contact once, by the owner or the retention period', () => {
    expect(() => eraseLeadContact(lead, ctx(INTEGRATION, 1))).toThrow(/owner or the system/);
    const erased = eraseLeadContact(lead, ctx(SYSTEM, 1));
    expect(erased).toMatchObject({ contactErasedAt: at(1), status: 'new', version: 2 });
    expect(() => eraseLeadContact(erased, ctx(OWNER, 2))).toThrow(/already/);
  });
});
