/**
 * @roi-dealer/events — Event History contracts (PHASE 03).
 *
 * Every change of business state leaves an immutable event (constitution §2.2): who changed
 * what, when, as which version, within which request. Events are stored in PostgreSQL in the
 * same transaction as the change (@roi-dealer/database); this package only defines their shape.
 */
import { z } from 'zod';
import {
  actorSchema,
  ENTITY_TYPES,
  entityRefSchema,
  timestampSchema,
  type EntityType,
} from '@roi-dealer/domain';

/** Records that are never updated: they only have a `created` event (§2.2). */
export const APPEND_ONLY_ENTITY_TYPES = [
  'evidence',
  'decision',
  'cost_entry',
  'knowledge_asset',
] as const satisfies readonly EntityType[];

export const VERSIONED_ENTITY_TYPES = ENTITY_TYPES.filter(
  (type) => !(APPEND_ONLY_ENTITY_TYPES as readonly EntityType[]).includes(type),
);

export const EVENT_KINDS = ['created', 'updated'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** `<entity>.created` for every entity, `<entity>.updated` for versioned ones. */
export const EVENT_TYPES = [
  ...ENTITY_TYPES.map((type) => `${type}.created` as const),
  ...VERSIONED_ENTITY_TYPES.map((type) => `${type}.updated` as const),
] as const;
export const eventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventTypeSchema>;

export function entityEventType(entity: EntityType, kind: EventKind): EventType {
  return eventTypeSchema.parse(`${entity}.${kind}`);
}

export const eventIdSchema = z.uuid().brand<'EventId'>();
export type EventId = z.infer<typeof eventIdSchema>;

/** Same format as the `x-correlation-id` header and the bot's `tg-update-<id>` ids. */
export const correlationIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

/** Key of a command that must run at most once, e.g. `tg-callback-<id>`. */
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);

/** Snapshot of the entity at `aggregateVersion`; `previousStatus` on updates. */
export const eventPayloadSchema = z.strictObject({
  snapshot: z.record(z.string(), z.unknown()),
  previousStatus: z.string().min(1).max(64).optional(),
});
export type EventPayload = z.infer<typeof eventPayloadSchema>;

const eventShape = {
  id: eventIdSchema,
  type: eventTypeSchema,
  aggregate: entityRefSchema,
  aggregateVersion: z.int().min(1),
  /** Domain time of the change (the entity's `createdAt` / `updatedAt`). */
  occurredAt: timestampSchema,
  actor: actorSchema,
  correlationId: correlationIdSchema.optional(),
  payload: eventPayloadSchema,
};

function typeMatchesAggregate(event: {
  type: EventType;
  aggregate: { type: EntityType };
  aggregateVersion: number;
}): boolean {
  const [entity, kind] = event.type.split('.');
  return entity === event.aggregate.type && (kind === 'created') === (event.aggregateVersion === 1);
}
const TYPE_RULE = {
  message: 'event type must name the aggregate; created ⇔ version 1',
  path: ['type'],
};

/** An event before it is stored. */
export const newEventSchema = z.strictObject(eventShape).refine(typeMatchesAggregate, TYPE_RULE);
export type NewEvent = z.infer<typeof newEventSchema>;

/** A stored event: global order and the database time of recording. */
export const storedEventSchema = z
  .strictObject({
    ...eventShape,
    position: z.int().min(1),
    recordedAt: timestampSchema,
  })
  .refine(typeMatchesAggregate, TYPE_RULE);
export type StoredEvent = z.infer<typeof storedEventSchema>;

export const PACKAGE_NAME = '@roi-dealer/events';
