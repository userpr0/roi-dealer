import type { Database } from '@roi-dealer/database';
import {
  normalizePhone,
  propertyChannelOf,
  propertyMaterialSchema,
  PROPERTY_CONTACT_WAYS,
  toTimestamp,
  timestampMs,
  type Actor,
  type PropertyChannel,
  type PropertyContactWay,
  type PropertyId,
  type Timestamp,
} from '@roi-dealer/domain';
import { CONSENT_VALUE, MAX_FORM_BYTES } from './form.js';

/*
 * The lead form of an own object's page (phase 36, ADR-0016 §12): a phone (required), a name
 * (optional), how to contact, the consent box and a trap field. The lead goes to the funnel and
 * the phone to `property_contacts` in one transaction; a repeat of the same phone for the same
 * object within a day is not a new lead. Nothing of the form is logged.
 */

export const PROPERTY_FORM_FIELDS = {
  phone: 'phone',
  name: 'name',
  way: 'way',
  consent: 'consent',
  /** Hidden from people by CSS; a filled trap is a robot. */
  trap: 'website',
  /** The channel and material tags of the page's address, carried by the form. */
  channel: 'c',
  material: 'm',
} as const;

export const MAX_LEAD_NAME = 60;
/** The same phone for the same object within this time is the same lead. */
export const PROPERTY_LEAD_REPEAT_MS = 24 * 3_600_000;

export type PropertyLeadForm =
  | {
      readonly kind: 'valid';
      readonly phone: string;
      readonly name?: string | undefined;
      readonly way: PropertyContactWay;
      readonly channel: PropertyChannel;
      readonly material?: string | undefined;
    }
  | { readonly kind: 'invalid'; readonly reason: 'phone' | 'name' | 'consent' }
  | { readonly kind: 'trap' };

/** A name as people write it: letters, spaces, apostrophes and hyphens. */
const NAME_SHAPE = /^[\p{L}][\p{L} '’.-]*$/u;

export function parsePropertyLeadForm(body: string): PropertyLeadForm {
  const form = new URLSearchParams(body.slice(0, MAX_FORM_BYTES));
  if ((form.get(PROPERTY_FORM_FIELDS.trap) ?? '').trim() !== '') return { kind: 'trap' };
  const phone = normalizePhone(form.get(PROPERTY_FORM_FIELDS.phone) ?? '');
  if (phone === undefined) return { kind: 'invalid', reason: 'phone' };
  const rawName = (form.get(PROPERTY_FORM_FIELDS.name) ?? '').trim().replace(/\s+/g, ' ');
  if (rawName !== '' && (rawName.length > MAX_LEAD_NAME || !NAME_SHAPE.test(rawName))) {
    return { kind: 'invalid', reason: 'name' };
  }
  if (form.get(PROPERTY_FORM_FIELDS.consent) !== CONSENT_VALUE) {
    return { kind: 'invalid', reason: 'consent' };
  }
  const way = form.get(PROPERTY_FORM_FIELDS.way) ?? 'call';
  const material = propertyMaterialSchema.safeParse(form.get(PROPERTY_FORM_FIELDS.material) ?? '');
  return {
    kind: 'valid',
    phone,
    ...(rawName === '' ? {} : { name: rawName }),
    way: (PROPERTY_CONTACT_WAYS as readonly string[]).includes(way)
      ? (way as PropertyContactWay)
      : 'call',
    channel: propertyChannelOf(form.get(PROPERTY_FORM_FIELDS.channel) ?? undefined),
    ...(material.success && material.data !== '' ? { material: material.data } : {}),
  };
}

export interface PropertyLead {
  readonly propertyId: PropertyId;
  readonly phone: string;
  readonly name?: string | undefined;
  readonly way: PropertyContactWay;
  readonly channel: PropertyChannel;
  readonly material?: string | undefined;
  readonly at: Timestamp;
  readonly correlationId?: string | undefined;
}

/**
 * Records a lead of an object's page as `actor` (the page): the funnel's `lead` step and the
 * phone together. The same phone for the same object within a day is `existing`.
 */
export async function capturePropertyLead(
  database: Pick<Database, 'transaction'>,
  lead: PropertyLead,
  actor: Actor,
): Promise<'created' | 'existing'> {
  return database.transaction(
    async (scope) => {
      const since = toTimestamp(new Date(timestampMs(lead.at) - PROPERTY_LEAD_REPEAT_MS));
      if (await scope.properties.hasRecentContact(lead.propertyId, lead.phone, since, actor)) {
        return 'existing';
      }
      const leadId = await scope.properties.track(
        {
          propertyId: lead.propertyId,
          step: 'lead',
          channel: lead.channel,
          material: lead.material,
          correlationId: lead.correlationId,
        },
        actor,
      );
      await scope.properties.addContact(
        {
          leadId,
          propertyId: lead.propertyId,
          phone: lead.phone,
          name: lead.name,
          preferred: lead.way,
          consentAt: lead.at,
        },
        actor,
      );
      return 'created';
    },
    { correlationId: lead.correlationId },
  );
}
