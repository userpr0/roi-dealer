import { z } from 'zod';
import {
  mutableMeta,
  mutableMetaShape,
  parseEntity,
  transition,
  type CreateContext,
  type DomainContext,
} from '../entity.js';
import {
  countryCodeSchema,
  httpUrlSchema,
  languageTagSchema,
  sourceIdSchema,
  titleSchema,
  uniqueList,
  type SourceId,
} from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';

export const SOURCE_KINDS = [
  'website',
  'forum',
  'social',
  'marketplace',
  'review_site',
  'search_trends',
  'news',
  'dataset',
  'manual',
  'other',
] as const;
export const TRUST_LEVELS = ['unverified', 'low', 'medium', 'high'] as const;

export const SOURCE_STATUSES = ['active', 'paused', 'retired'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const sourceLifecycle = defineStateMachine<SourceStatus>('source', {
  active: ['paused', 'retired'],
  paused: ['active', 'retired'],
  retired: [],
});

const newSourceShape = {
  kind: z.enum(SOURCE_KINDS),
  name: titleSchema,
  url: httpUrlSchema.optional(),
  markets: uniqueList(countryCodeSchema, { min: 1, max: 50 }),
  languages: uniqueList(languageTagSchema, { min: 1, max: 20 }),
  trust: z.enum(TRUST_LEVELS),
};

/** Where market data comes from. */
export const newSourceSchema = z.strictObject(newSourceShape);
export type NewSource = z.infer<typeof newSourceSchema>;

export const sourceSchema = z.object({
  ...newSourceShape,
  id: sourceIdSchema,
  status: z.enum(SOURCE_STATUSES),
  ...mutableMetaShape,
});
export type Source = z.infer<typeof sourceSchema>;

export function createSource(data: NewSource, context: CreateContext<SourceId>): Source {
  return parseEntity(sourceSchema, 'source', {
    ...data,
    id: context.id,
    status: 'active',
    ...mutableMeta(context),
  });
}

export function changeSourceStatus(
  source: Source,
  to: SourceStatus,
  context: DomainContext,
): Source {
  return transition(source, sourceLifecycle, sourceSchema, to, context);
}
