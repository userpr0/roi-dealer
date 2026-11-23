import { z } from 'zod';
import {
  assertOwner,
  mutableMeta,
  mutableMetaShape,
  parseEntity,
  transition,
  type CreateContext,
  type DomainContext,
} from '../entity.js';
import { containsContactData } from '../privacy.js';
import { propertyIdSchema, type PropertyId } from '../primitives.js';
import { defineStateMachine } from '../state-machine.js';

/*
 * The owner's own real estate (phase 36, ADR-0016 part 2, D-040): objects in Ukraine, first in
 * Kyiv oblast. Only the owner creates an object and changes it; the page of a listed object is
 * public, so its texts hold no contacts, links or house numbers — the code adds the contact.
 */

export const PROPERTY_KINDS = ['apartment', 'house', 'commercial', 'land'] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

export const PROPERTY_DEALS = ['sale', 'rent'] as const;
export type PropertyDeal = (typeof PROPERTY_DEALS)[number];

export const PROPERTY_STATUSES = ['draft', 'listed', 'under_offer', 'closed', 'withdrawn'] as const;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

/** Statuses whose page is public (ADR-0016 §10); after them the page answers 410. */
export const PUBLIC_PROPERTY_STATUSES: readonly PropertyStatus[] = ['listed', 'under_offer'];

export const MAX_PROPERTY_TEXT = 500;
/** The highest price: $20 000 000 in cents (an `integer` column). */
export const MAX_PROPERTY_PRICE_CENTS = 2_000_000_000;

/** A link or a site name: the page gets links only from code. */
const LINK_PATTERN = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|ua|net|org|info|me|io)\b/i;
/** A Ukrainian phone number without `+`: `067 123 45 67`, `(067) 123-45-67`, `0671234567`. */
const UA_PHONE_PATTERN = /(?<!\d)\(?0\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/;
/** A house number at the end of a street: `Соборна 42`, `Соборна, 42а`, `Миру 7/2`. */
const HOUSE_NUMBER_PATTERN = /[\s,]\d+[а-яіїєґa-z]?(?:\/\d+[а-яіїєґa-z]?)?\.?$/iu;

/** True when public text may hold a contact or a link (the page adds the contact itself). */
export function hasContactOrLink(text: string): boolean {
  return containsContactData(text) || UA_PHONE_PATTERN.test(text) || LINK_PATTERN.test(text);
}

const plainText = (max: number) =>
  z
    .string()
    .transform((value) =>
      value
        .trim()
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n'),
    )
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .refine((value) => !hasContactOrLink(value), {
          message: 'no phone numbers, emails or links: the page adds the contact',
        }),
    );

/** A one-line name: a settlement, a region, a street or the object's title. */
const lineText = (max: number) =>
  plainText(max).refine((value) => !value.includes('\n'), { message: 'one line' });

/** The street without the house number (ADR-0016 §8): the exact address is not public. */
export const propertyStreetSchema = lineText(80).refine(
  (value) => !HOUSE_NUMBER_PATTERN.test(value),
  { message: 'the street without the house number' },
);

/** The address of the page: `/o/<slug>`. */
export const propertySlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'latin letters, digits and hyphens')
  .min(3)
  .max(60);

const newPropertyShape = {
  slug: propertySlugSchema,
  /** The owner's short name of the object, e.g. «Тетиев, Соборна, 42 м², аренда». */
  title: lineText(60),
  kind: z.enum(PROPERTY_KINDS),
  deal: z.enum(PROPERTY_DEALS),
  region: lineText(60),
  settlement: lineText(60),
  street: propertyStreetSchema.optional(),
  /** Square metres, with one decimal at most. */
  areaM2: z
    .number()
    .positive()
    .max(1_000_000)
    .refine((value) => Number.isInteger(value * 10), { message: 'one decimal at most' }),
  rooms: z.int().min(0).max(100).optional(),
  floor: z.int().min(-5).max(200).optional(),
  floors: z.int().min(1).max(200).optional(),
  /** The land plot in sotky (100 m²). */
  landSotky: z
    .number()
    .positive()
    .max(100_000)
    .refine((value) => Number.isInteger(value * 100), { message: 'two decimals at most' })
    .optional(),
  separateEntrance: z.boolean().optional(),
  /** USD cents (D-005): the sale price, or the monthly rent. */
  priceCents: z.int().positive().max(MAX_PROPERTY_PRICE_CENTS),
  negotiable: z.boolean(),
  condition: plainText(MAX_PROPERTY_TEXT).optional(),
  utilities: plainText(MAX_PROPERTY_TEXT).optional(),
  /** Rent: term, deposit, who pays the utilities. */
  rentTerms: plainText(MAX_PROPERTY_TEXT).optional(),
  /** Commercial: purpose, who may work there, what was there before. */
  purpose: plainText(MAX_PROPERTY_TEXT).optional(),
  nearby: plainText(MAX_PROPERTY_TEXT).optional(),
  /** The owner's offer to a buyer or a tenant, e.g. a month of rent holidays. */
  offer: plainText(MAX_PROPERTY_TEXT).optional(),
  /** What is honest to say: the minuses a visitor will see anyway. */
  cons: plainText(MAX_PROPERTY_TEXT).optional(),
};

export const newPropertySchema = z
  .strictObject(newPropertyShape)
  .refine(
    (data) => data.floor === undefined || data.floors === undefined || data.floor <= data.floors,
    {
      message: 'the floor is above the number of floors',
      path: ['floor'],
    },
  )
  .refine((data) => data.deal === 'rent' || data.rentTerms === undefined, {
    message: 'rent terms only for a rent',
    path: ['rentTerms'],
  });
export type NewProperty = z.infer<typeof newPropertySchema>;

export const propertySchema = z.object({
  ...newPropertyShape,
  id: propertyIdSchema,
  status: z.enum(PROPERTY_STATUSES),
  ...mutableMetaShape,
});
export type Property = z.infer<typeof propertySchema>;

export const propertyLifecycle = defineStateMachine<PropertyStatus>('property', {
  draft: ['listed', 'withdrawn'],
  listed: ['under_offer', 'closed', 'withdrawn'],
  under_offer: ['listed', 'closed', 'withdrawn'],
  closed: [],
  withdrawn: [],
});

/** The owner adds an object as a draft; nothing is public until it is listed. */
export function createProperty(data: NewProperty, context: CreateContext<PropertyId>): Property {
  assertOwner(context.actor, 'add an own property');
  const parsed = newPropertySchema.parse(data);
  return parseEntity(propertySchema, 'property', {
    ...parsed,
    id: context.id,
    status: 'draft',
    ...mutableMeta(context),
  });
}

/** Only the owner lists, withdraws or closes an object (ADR-0016 §8). */
export function setPropertyStatus(
  property: Property,
  status: PropertyStatus,
  context: DomainContext,
): Property {
  assertOwner(context.actor, 'change the status of an own property');
  return transition(property, propertyLifecycle, propertySchema, status, context);
}

/** A slug from the settlement and the deal plus a short unique tail, e.g. `tetiiv-orenda-3f9a`. */
export function propertySlug(settlement: string, deal: PropertyDeal, tail: string): string {
  const latin = transliterate(settlement)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  const kind = deal === 'sale' ? 'prodazh' : 'orenda';
  return propertySlugSchema.parse(
    [
      latin === '' ? 'obiekt' : latin,
      kind,
      tail
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 6),
    ]
      .filter((part) => part !== '')
      .join('-'),
  );
}

/** The official Ukrainian transliteration (2010), plus Russian letters, close enough for a URL. */
const LETTERS: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'h',
  ґ: 'g',
  д: 'd',
  е: 'e',
  є: 'ie',
  ж: 'zh',
  з: 'z',
  и: 'y',
  і: 'i',
  ї: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ь: '',
  ю: 'iu',
  я: 'ia',
  ы: 'y',
  э: 'e',
  ё: 'io',
  ъ: '',
  "'": '',
  '’': '',
};

function transliterate(text: string): string {
  return [...text.toLowerCase()].map((letter) => LETTERS[letter] ?? letter).join('');
}
