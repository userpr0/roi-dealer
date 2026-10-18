import { z } from 'zod';
import { immutableMeta, immutableMetaShape, parseEntity, type CreateContext } from '../entity.js';
import {
  httpUrlSchema,
  sourceIdSchema,
  sourceSnapshotIdSchema,
  timestampMs,
  timestampSchema,
  type SourceSnapshotId,
} from '../primitives.js';

/** Upper bound of items one load may report. */
export const MAX_SNAPSHOT_ITEMS = 10_000;

const countSchema = z.int().min(0).max(MAX_SNAPSHOT_ITEMS);

const newSourceSnapshotShape = {
  sourceId: sourceIdSchema,
  /** The request that was made, without credentials. */
  requestUrl: httpUrlSchema,
  fetchedAt: timestampSchema,
  /** SHA-256 of the raw responses, in request order: proves what was received. */
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase hex SHA-256'),
  /** Items the source returned that were new to us. */
  itemCount: countSchema,
  /** Evidence stored from them; skipped items (deleted, empty) make the difference. */
  evidenceCount: countSchema,
};

/**
 * One load from a source (PHASE 05 provenance): Evidence → snapshot → source → catalog entry.
 * The raw response is not kept (data minimization, D-014 п.6); its hash is.
 */
export const newSourceSnapshotSchema = z.strictObject(newSourceSnapshotShape);
export type NewSourceSnapshot = z.infer<typeof newSourceSnapshotSchema>;

export const sourceSnapshotSchema = z
  .object({ ...newSourceSnapshotShape, id: sourceSnapshotIdSchema, ...immutableMetaShape })
  .refine((snapshot) => snapshot.evidenceCount <= snapshot.itemCount, {
    message: 'evidenceCount must not exceed itemCount',
    path: ['evidenceCount'],
  })
  .refine((snapshot) => timestampMs(snapshot.fetchedAt) <= timestampMs(snapshot.createdAt), {
    message: 'fetchedAt must not be later than createdAt',
    path: ['fetchedAt'],
  });
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;

export function createSourceSnapshot(
  data: NewSourceSnapshot,
  context: CreateContext<SourceSnapshotId>,
): SourceSnapshot {
  return parseEntity(sourceSnapshotSchema, 'source_snapshot', {
    ...data,
    id: context.id,
    ...immutableMeta(context),
  });
}
