import { describe, expect, it } from 'vitest';
import {
  accessRequestFor,
  catalogEntrySchema,
  connectableEntry,
  integrationActor,
  SOURCE_CATALOG,
  sourceFor,
} from '@roi-dealer/evidence';
import { newPrincipalSchema, newSourceSchema } from '@roi-dealer/domain';

describe('source catalog (D-014 п.5)', () => {
  it('records every checked source with its terms, costs, limits and verdict', () => {
    for (const entry of SOURCE_CATALOG) {
      expect(catalogEntrySchema.safeParse(entry).success).toBe(true);
    }
    const keys = SOURCE_CATALOG.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(
      Object.fromEntries(SOURCE_CATALOG.map((entry) => [entry.key, entry.review.verdict])),
    ).toEqual({
      'hacker-news': 'allowed',
      reddit: 'needs_agreement',
      'cfpb-complaints': 'rejected',
      'stack-exchange': 'needs_review',
      bluesky: 'needs_review',
      'product-hunt': 'needs_review',
      'google-trends': 'rejected',
    });
  });

  it('lets connectors work only with allowed entries', () => {
    expect(connectableEntry('hacker-news').key).toBe('hacker-news');
    expect(() => connectableEntry('unknown-forum')).toThrow(
      expect.objectContaining({ code: 'not_cataloged' }),
    );
    for (const key of ['reddit', 'cfpb-complaints', 'stack-exchange']) {
      expect(() => connectableEntry(key)).toThrow(expect.objectContaining({ code: 'not_allowed' }));
    }
  });

  it('builds the owner’s access request and the source record from the entry', () => {
    for (const entry of SOURCE_CATALOG) {
      const request = accessRequestFor(entry);
      expect(newPrincipalSchema.safeParse(request).success).toBe(true);
      expect(newSourceSchema.safeParse(sourceFor(entry)).success).toBe(true);
    }
    const hackerNews = connectableEntry('hacker-news');
    expect(integrationActor(hackerNews)).toEqual({ type: 'integration', id: 'source:hacker-news' });
    expect(accessRequestFor(hackerNews).purpose).toContain('Без ников, профилей и контактов');
    expect(sourceFor(hackerNews)).toMatchObject({ catalogKey: 'hacker-news', trust: 'medium' });
  });
});
