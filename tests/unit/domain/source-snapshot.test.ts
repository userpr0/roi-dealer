import { describe, expect, it } from 'vitest';
import {
  containsContactData,
  createEvidence,
  createSource,
  createSourceSnapshot,
  evidenceIdSchema,
  newEvidenceSchema,
  sourceIdSchema,
  sourceSchema,
  sourceSnapshotIdSchema,
  sourceSnapshotSchema,
  type NewSourceSnapshot,
} from '@roi-dealer/domain';
import { uuidv7 } from '@roi-dealer/shared';
import {
  at,
  createCtx,
  evidenceData,
  INTEGRATION,
  sourceData,
  SYSTEM,
} from '../../support/domain.js';

const sourceId = sourceIdSchema.parse(uuidv7());

function snapshotData(overrides: Partial<NewSourceSnapshot> = {}): NewSourceSnapshot {
  return {
    sourceId,
    requestUrl: 'https://hacker-news.firebaseio.com/v0/askstories.json',
    fetchedAt: at(0),
    contentSha256: 'a'.repeat(64),
    itemCount: 3,
    evidenceCount: 2,
    ...overrides,
  };
}

describe('SourceSnapshot (PHASE 05)', () => {
  it('records one load: request, time, hash and counts, never the raw response', () => {
    const snapshot = createSourceSnapshot(
      snapshotData(),
      createCtx(sourceSnapshotIdSchema, INTEGRATION, 0),
    );
    expect(snapshot).toMatchObject({ itemCount: 3, evidenceCount: 2, createdBy: INTEGRATION });
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        'contentSha256',
        'createdAt',
        'createdBy',
        'evidenceCount',
        'fetchedAt',
        'id',
        'itemCount',
        'requestUrl',
        'sourceId',
      ].sort(),
    );
  });

  it('rejects more evidence than items, a load after its record and a bad hash', () => {
    for (const data of [
      snapshotData({ evidenceCount: 4 }),
      snapshotData({ fetchedAt: at(1) }),
      snapshotData({ contentSha256: 'ABC' }),
    ]) {
      expect(() =>
        createSourceSnapshot(data, createCtx(sourceSnapshotIdSchema, INTEGRATION, 0)),
      ).toThrow(expect.objectContaining({ code: 'invariant_violation' }));
    }
    expect(sourceSnapshotSchema.safeParse({}).success).toBe(false);
  });
});

describe('Evidence without contact data (D-014 п.6)', () => {
  it('rejects an excerpt with an email address or a phone number', () => {
    for (const excerpt of ['Contact me: jane@example.com', 'Call 555-123-4567 today']) {
      expect(containsContactData(excerpt)).toBe(true);
      expect(newEvidenceSchema.safeParse(evidenceData(sourceId, { excerpt })).success).toBe(false);
      expect(() =>
        createEvidence(
          evidenceData(sourceId, { excerpt }),
          createCtx(evidenceIdSchema, INTEGRATION, 0),
        ),
      ).toThrow(expect.objectContaining({ code: 'invariant_violation' }));
    }
  });

  it('keeps provenance: the load and the id at the source', () => {
    const snapshotId = sourceSnapshotIdSchema.parse(uuidv7());
    const evidence = createEvidence(
      evidenceData(sourceId, { snapshotId, externalId: '42' }),
      createCtx(evidenceIdSchema, INTEGRATION, 0),
    );
    expect(evidence).toMatchObject({ snapshotId, externalId: '42' });
    expect(
      newEvidenceSchema.safeParse(evidenceData(sourceId, { externalId: 'with space' })).success,
    ).toBe(false);
  });
});

describe('Source catalog key (PHASE 05)', () => {
  it('connects a source to a catalog entry by a key of a fixed format', () => {
    const source = createSource(
      sourceData({ catalogKey: 'hacker-news' }),
      createCtx(sourceIdSchema, SYSTEM, 0),
    );
    expect(source.catalogKey).toBe('hacker-news');
    expect(sourceSchema.safeParse({ ...source, catalogKey: 'Hacker News' }).success).toBe(false);
  });
});
