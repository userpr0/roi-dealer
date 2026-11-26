import {
  DomainError,
  MAX_PROPERTY_PHOTOS,
  needsPrincipal,
  toTimestamp,
  type Actor,
  type PropertyChannel,
  type PropertyContactWay,
  type PropertyFunnelStep,
  type PropertyId,
  type Timestamp,
} from '@roi-dealer/domain';
import { decideAccess, type Permission } from '@roi-dealer/policies';
import { findPrincipal } from './access.js';
import { translated } from './errors.js';
import type { Executor } from './executor.js';

/*
 * The page of an own object (phase 36, ADR-0016 §9–12, migration 0030): photos, the funnel and
 * the phones of leads. The page writes views and leads as the integration `site`; calls,
 * showings and deals, the photos and every read of a phone are the owner's. Phones live only in
 * `property_contacts`: no events, deleted for real.
 */

export interface PropertyPhotoInfo {
  readonly position: number;
  readonly width: number;
  readonly height: number;
}

export interface PropertyFunnelEntry {
  readonly propertyId: PropertyId;
  readonly step: PropertyFunnelStep;
  readonly channel: PropertyChannel;
  readonly material?: string | undefined;
  /** The lead a call, showing or deal followed. */
  readonly leadId?: number | undefined;
  readonly correlationId?: string | undefined;
}

export interface PropertyLead {
  readonly id: number;
  readonly propertyId: PropertyId;
  readonly channel: PropertyChannel;
  readonly material?: string | undefined;
  readonly occurredAt: Timestamp;
  /** Absent once the phone was deleted. */
  readonly preferred?: PropertyContactWay | undefined;
}

export interface PropertyContact {
  readonly leadId: number;
  readonly propertyId: PropertyId;
  /** `+<digits>` (normalizePhone). */
  readonly phone: string;
  readonly name?: string | undefined;
  readonly preferred: PropertyContactWay;
  readonly consentAt: Timestamp;
}

/** Steps by channel and material: what brought views, leads, calls, showings and deals. */
export interface PropertyFunnelCount {
  readonly propertyId: PropertyId;
  readonly step: PropertyFunnelStep;
  readonly channel: PropertyChannel;
  readonly material?: string | undefined;
  readonly count: number;
}

export interface PropertyQueries {
  /** Adds a photo at the next position; undefined when the object has 15. `property.manage`. */
  addPhoto(
    propertyId: PropertyId,
    photo: { readonly content: Uint8Array; readonly width: number; readonly height: number },
    actor: Actor,
  ): Promise<number | undefined>;
  /** Deletes every photo of the object; returns how many. `property.manage`. */
  removePhotos(propertyId: PropertyId, actor: Actor): Promise<number>;
  /** The photos of an object in their order, without their bytes (public: the page). */
  photos(propertyId: PropertyId): Promise<PropertyPhotoInfo[]>;
  /** One photo's JPEG bytes (public: the page). */
  photo(propertyId: PropertyId, position: number): Promise<Uint8Array | undefined>;

  /**
   * Appends a funnel step; returns its id. Views need `funnel.track`, leads `lead.capture` (the
   * page), calls, showings and deals `property.manage` (the owner).
   */
  track(entry: PropertyFunnelEntry, actor: Actor): Promise<number>;
  /** Steps of these objects by channel and material. */
  counts(propertyIds: readonly PropertyId[]): Promise<PropertyFunnelCount[]>;
  /** One lead of the page. */
  lead(leadId: number): Promise<PropertyLead | undefined>;
  /** Leads of the last 7 days whose notice was not sent (`property-lead-notice-<id>`). */
  pendingNotices(limit?: number): Promise<PropertyLead[]>;

  /** Stores the phone of a new lead. `lead.capture`. */
  addContact(contact: PropertyContact, actor: Actor): Promise<void>;
  /** Whether this phone left a lead for the object since `since` (a repeat is not a new lead). */
  hasRecentContact(
    propertyId: PropertyId,
    phone: string,
    since: Timestamp,
    actor: Actor,
  ): Promise<boolean>;
  /** The phone of a lead, for the owner's «показать контакт». `property.manage`. */
  contact(leadId: number, actor: Actor): Promise<PropertyContact | undefined>;
  /** Deletes the phones of an object's leads (closed or withdrawn). `property.manage`. */
  eraseContacts(propertyId: PropertyId, actor: Actor): Promise<number>;
  /** How many leads still hold this phone (the /forget question). `lead.manage`. */
  phoneLeads(phone: string, actor: Actor): Promise<number>;
  /** Deletes every lead's phone that matches (a person's request). `lead.manage`. */
  forgetPhone(phone: string, actor: Actor): Promise<number>;
  /** Deletes the phones left before `before` (retention). `lead.manage`. */
  purgeContacts(before: Timestamp, actor: Actor): Promise<number>;
}

async function authorize(executor: Executor, actor: Actor, permission: Permission): Promise<void> {
  const principal = needsPrincipal(actor) ? await findPrincipal(executor, actor) : undefined;
  const decision = decideAccess(actor, permission, principal);
  if (!decision.allowed) {
    throw new DomainError('permission_denied', `The ${actor.type} may not ${permission}`, {
      actor_type: actor.type,
      permission,
      reason: decision.reason,
    });
  }
}

const STEP_PERMISSIONS: Readonly<Record<PropertyFunnelStep, Permission>> = {
  view: 'funnel.track',
  lead: 'lead.capture',
  call: 'property.manage',
  showing: 'property.manage',
  deal: 'property.manage',
};

type LeadRow = {
  id: string;
  property_id: PropertyId;
  channel: PropertyChannel;
  material: string | null;
  occurred_at: Date;
  preferred: PropertyContactWay | null;
};
const leadOf = (row: LeadRow): PropertyLead => ({
  id: Number(row.id),
  propertyId: row.property_id,
  channel: row.channel,
  ...(row.material === null ? {} : { material: row.material }),
  occurredAt: toTimestamp(row.occurred_at),
  ...(row.preferred === null ? {} : { preferred: row.preferred }),
});

export function createPropertyQueries(executor: Executor): PropertyQueries {
  return {
    addPhoto: (propertyId, photo, actor) =>
      translated(async () => {
        await authorize(executor, actor, 'property.manage');
        const rows = await executor<{ position: number }[]>`
          insert into property_photos (property_id, position, content, width, height)
          select ${propertyId}, coalesce(max(position), 0) + 1, ${photo.content},
                 ${photo.width}, ${photo.height}
          from property_photos where property_id = ${propertyId}
          having coalesce(max(position), 0) < ${MAX_PROPERTY_PHOTOS}
          returning position
        `;
        return rows[0]?.position;
      }),

    removePhotos: (propertyId, actor) =>
      translated(async () => {
        await authorize(executor, actor, 'property.manage');
        const rows = await executor`
          delete from property_photos where property_id = ${propertyId} returning position
        `;
        return rows.length;
      }),

    photos: (propertyId) =>
      translated(async () => {
        const rows = await executor<PropertyPhotoInfo[]>`
          select position, width, height from property_photos
          where property_id = ${propertyId} order by position
        `;
        return rows.map((row) => ({
          position: row.position,
          width: row.width,
          height: row.height,
        }));
      }),

    photo: (propertyId, position) =>
      translated(async () => {
        const rows = await executor<{ content: Uint8Array }[]>`
          select content from property_photos
          where property_id = ${propertyId} and position = ${position}
        `;
        return rows[0]?.content;
      }),

    track: (entry, actor) =>
      translated(async () => {
        await authorize(executor, actor, STEP_PERMISSIONS[entry.step]);
        const rows = await executor<{ id: string }[]>`
          insert into property_funnel (
            property_id, step, channel, material, lead_id, actor_type, actor_id, correlation_id
          ) values (
            ${entry.propertyId}, ${entry.step}, ${entry.channel}, ${entry.material ?? null},
            ${entry.leadId ?? null}, ${actor.type}, ${actor.id}, ${entry.correlationId ?? null}
          )
          returning id::text as id
        `;
        return Number(rows[0]?.id);
      }),

    counts: (propertyIds) =>
      translated(async () => {
        if (propertyIds.length === 0) return [];
        const rows = await executor<
          {
            property_id: PropertyId;
            step: PropertyFunnelStep;
            channel: PropertyChannel;
            material: string | null;
            count: string;
          }[]
        >`
          select property_id, step, channel, material, count(*)::text as count
          from property_funnel where property_id in ${executor([...propertyIds])}
          group by property_id, step, channel, material
          order by property_id, step, channel, material nulls first
        `;
        return rows.map((row) => ({
          propertyId: row.property_id,
          step: row.step,
          channel: row.channel,
          ...(row.material === null ? {} : { material: row.material }),
          count: Number(row.count),
        }));
      }),

    lead: (leadId) =>
      translated(async () => {
        const rows = await executor<LeadRow[]>`
          select f.id::text as id, f.property_id, f.channel, f.material, f.occurred_at, c.preferred
          from property_funnel f left join property_contacts c on c.lead_id = f.id
          where f.id = ${leadId} and f.step = 'lead'
        `;
        const [row] = rows;
        return row === undefined ? undefined : leadOf(row);
      }),

    pendingNotices: (limit = 20) =>
      translated(async () => {
        const rows = await executor<LeadRow[]>`
          select f.id::text as id, f.property_id, f.channel, f.material, f.occurred_at, c.preferred
          from property_funnel f left join property_contacts c on c.lead_id = f.id
          where f.step = 'lead' and f.occurred_at > now() - interval '7 days'
            and not exists (
              select 1 from idempotency_keys k
              where k.key = 'property-lead-notice-' || f.id::text
            )
          order by f.id limit ${Math.max(1, Math.min(limit, 50))}
        `;
        return rows.map(leadOf);
      }),

    addContact: (contact, actor) =>
      translated(async () => {
        await authorize(executor, actor, 'lead.capture');
        await executor`
          insert into property_contacts (lead_id, property_id, phone, name, preferred, consent_at)
          values (${contact.leadId}, ${contact.propertyId}, ${contact.phone},
                  ${contact.name ?? null}, ${contact.preferred}, ${contact.consentAt})
        `;
      }),

    hasRecentContact: (propertyId, phone, since, actor) =>
      translated(async () => {
        await authorize(executor, actor, 'lead.capture');
        const rows = await executor`
          select 1 from property_contacts
          where property_id = ${propertyId} and phone = ${phone} and created_at >= ${since}
          limit 1
        `;
        return rows.length > 0;
      }),

    contact: (leadId, actor) =>
      translated(async () => {
        await authorize(executor, actor, 'property.manage');
        const rows = await executor<
          {
            lead_id: string;
            property_id: PropertyId;
            phone: string;
            name: string | null;
            preferred: PropertyContactWay;
            consent_at: Date;
          }[]
        >`
          select lead_id::text as lead_id, property_id, phone, name, preferred, consent_at
          from property_contacts where lead_id = ${leadId}
        `;
        const [row] = rows;
        return row === undefined
          ? undefined
          : {
              leadId: Number(row.lead_id),
              propertyId: row.property_id,
              phone: row.phone,
              ...(row.name === null ? {} : { name: row.name }),
              preferred: row.preferred,
              consentAt: toTimestamp(row.consent_at),
            };
      }),

    eraseContacts: (propertyId, actor) =>
      translated(async () => {
        await authorize(executor, actor, 'property.manage');
        const rows = await executor`
          delete from property_contacts where property_id = ${propertyId} returning lead_id
        `;
        return rows.length;
      }),

    phoneLeads: (phone, actor) =>
      translated(async () => {
        await authorize(executor, actor, 'lead.manage');
        const rows = await executor<{ count: string }[]>`
          select count(*)::text as count from property_contacts where phone = ${phone}
        `;
        return Number(rows[0]?.count ?? 0);
      }),

    forgetPhone: (phone, actor) =>
      translated(async () => {
        await authorize(executor, actor, 'lead.manage');
        const rows = await executor`
          delete from property_contacts where phone = ${phone} returning lead_id
        `;
        return rows.length;
      }),

    purgeContacts: (before, actor) =>
      translated(async () => {
        await authorize(executor, actor, 'lead.manage');
        const rows = await executor`
          delete from property_contacts where created_at < ${before} returning lead_id
        `;
        return rows.length;
      }),
  };
}
