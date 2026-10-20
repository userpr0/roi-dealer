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
      'stack-exchange': 'needs_agreement',
      bluesky: 'allowed',
      'product-hunt': 'needs_agreement',
      github: 'rejected',
      'google-trends': 'needs_agreement',
      'npm-downloads': 'allowed',
      'wikimedia-pageviews': 'allowed',
      'pypi-downloads': 'allowed',
      'google-ads-keyword-planner': 'needs_agreement',
      'us-census': 'allowed',
      'us-bls': 'allowed',
      'uk-ons': 'allowed',
      'uk-companies-house': 'needs_review',
      'statistics-canada': 'allowed',
      'abs-australia': 'allowed',
      gdelt: 'allowed',
      'federal-register': 'allowed',
      'sec-edgar': 'allowed',
      youtube: 'rejected',
      'dev-to': 'rejected',
      'mastodon-social': 'needs_review',
      'app-store-reviews': 'rejected',
      'world-bank': 'allowed',
      eurostat: 'allowed',
      arxiv: 'allowed',
      openalex: 'allowed',
      crossref: 'allowed',
      'x-api': 'needs_agreement',
      quora: 'needs_review',
      'indie-hackers': 'needs_review',
      g2: 'needs_agreement',
      capterra: 'needs_agreement',
      trustpilot: 'needs_agreement',
      'google-play-reviews': 'rejected',
      'lemmy-world': 'allowed',
      threads: 'needs_review',
      tumblr: 'rejected',
      fred: 'needs_review',
      'us-bea': 'allowed',
      'uk-nomis': 'needs_review',
      'regulations-gov': 'allowed',
      guardian: 'rejected',
      newsapi: 'needs_agreement',
      'microsoft-ads-keywords': 'needs_review',
      oecd: 'needs_review',
    });
  });

  it('lets connectors work only with allowed entries', () => {
    expect(connectableEntry('hacker-news').key).toBe('hacker-news');
    for (const key of ['npm-downloads', 'bluesky', 'gdelt', 'sec-edgar']) {
      expect(connectableEntry(key).key).toBe(key);
    }
    expect(() => connectableEntry('unknown-forum')).toThrow(
      expect.objectContaining({ code: 'not_cataloged' }),
    );
    for (const key of ['reddit', 'cfpb-complaints', 'stack-exchange', 'youtube', 'quora']) {
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
