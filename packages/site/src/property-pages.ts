import { createHash, randomBytes } from 'node:crypto';
import {
  capturePropertyLead,
  CONSENT_VALUE,
  MAX_LEAD_NAME,
  parsePropertyLeadForm,
  PROPERTY_FORM_FIELDS,
} from '@roi-dealer/crm';
import type { Database, PropertyPhotoInfo } from '@roi-dealer/database';
import {
  PROPERTY_CONTACT_RETENTION_DAYS,
  propertyChannelOf,
  propertyMaterialSchema,
  propertySlugSchema,
  PUBLIC_PROPERTY_STATUSES,
  toTimestamp,
  type Property,
  type PropertyChannel,
} from '@roi-dealer/domain';
import { escapeHtml } from '@roi-dealer/media';
import type { Logger } from '@roi-dealer/observability';
import type { SubmissionLimiter } from './limits.js';
import type { SitePage } from './pages.js';
import { isVisit, SITE_TRACKER, type SiteTracker, type SiteVisit } from './tracker.js';

/*
 * The page of an own object (phase 36, ADR-0016 §10–12): Ukrainian, static HTML built by code —
 * every text escaped, no scripts, no external resources — with schema.org microdata in
 * attributes, never a `script` tag (D-042). Public while the object is listed or under offer;
 * after that 410. Views and leads go to the object's funnel with the channel `?c=` and the
 * material `?m=` of the address; the phone of a lead only to `property_contacts`.
 */

export const PROPERTY_STEPS = ['page', 'lead', 'thanks'] as const;
export type PropertyStep = (typeof PROPERTY_STEPS)[number];

export const PROPERTY_PRIVACY_PATH = '/o/privacy';

/** The public path of an object's page. */
export function propertyPath(slug: string, step: PropertyStep = 'page'): string {
  return step === 'page' ? `/o/${slug}` : `/o/${slug}/${step}`;
}

/** The address of a photo of the page. */
export function propertyPhotoPath(slug: string, position: number): string {
  return `/o/${slug}/photo/${String(position)}.jpg`;
}

const STYLE =
  ':root{color-scheme:light dark;--fg:#14161a;--bg:#fff;--muted:#5b616b;--card:#f4f5f7;--accent:#1f6feb;--line:#e3e5e8}' +
  '@media (prefers-color-scheme:dark){:root{--fg:#eceef1;--bg:#111316;--muted:#a2a8b2;--card:#1b1e23;--accent:#4c8dff;--line:#2a2e35}}' +
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
  'main{max-width:44rem;margin:0 auto;padding:2rem 1.25rem 3rem}h1{font-size:1.7rem;line-height:1.25;margin:0 0 .5rem}' +
  'h2{font-size:1.2rem;margin:2rem 0 .6rem}.price{font-size:1.45rem;font-weight:700;margin:.25rem 0 1rem}' +
  '.place,.muted{color:var(--muted)}.muted{font-size:.9rem}.facts{display:flex;flex-wrap:wrap;gap:.5rem;padding:0;list-style:none}' +
  '.facts li{background:var(--card);border-radius:.5rem;padding:.35rem .7rem}' +
  '.photos{display:grid;gap:.5rem;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));margin:1rem 0}' +
  '.photos img{width:100%;height:auto;border-radius:.6rem;display:block}' +
  '.banner{background:#fff4ce;color:#3b2f00;padding:.6rem 1rem;border-radius:.5rem}' +
  'form{background:var(--card);border-radius:.8rem;padding:1rem 1.1rem;margin-top:1rem}' +
  'label{display:block;margin:.8rem 0}input[type=tel],input[type=text]{display:block;width:100%;font:inherit;padding:.6rem;margin-top:.3rem;border:1px solid var(--line);border-radius:.5rem}' +
  'fieldset{border:0;padding:0;margin:.8rem 0}fieldset label{display:inline-block;margin:.2rem 1rem .2rem 0}' +
  'button{font:inherit;font-weight:600;padding:.75rem 1.3rem;border:0;border-radius:.6rem;background:var(--accent);color:#fff;cursor:pointer}' +
  '.hp{position:absolute;left:-10000px}.error{color:#b42318;font-weight:600}a{color:inherit}';

function documentPage(
  status: number,
  title: string,
  body: readonly string[],
  options: { readonly index?: boolean; readonly description?: string } = {},
): SitePage {
  const e = escapeHtml;
  return {
    status,
    html: [
      '<!doctype html>',
      '<html lang="uk">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<meta name="robots" content="${options.index === true ? 'index, follow' : 'noindex, nofollow'}">`,
      '<meta name="referrer" content="no-referrer">',
      ...(options.description === undefined
        ? []
        : [`<meta name="description" content="${e(options.description)}">`]),
      `<title>${e(title)}</title>`,
      `<style>${STYLE}</style>`,
      '</head>',
      '<body><main>',
      ...body,
      '</main></body>',
      '</html>',
    ].join('\n'),
  };
}

/** A plain Ukrainian notice page. */
export function propertyNotice(status: number, title: string, text: string): SitePage {
  return documentPage(status, title, [
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(text)}</p>`,
  ]);
}

export const PROPERTY_NOT_FOUND = propertyNotice(
  404,
  'Сторінку не знайдено',
  'Такої сторінки немає.',
);
export const PROPERTY_ENDED = propertyNotice(
  410,
  'Об’єкт більше не пропонується',
  'Дякуємо за інтерес. Цей об’єкт продано, здано або знято з пропозиції.',
);
const PAUSED = propertyNotice(
  503,
  'Заявки тимчасово не приймаються',
  'Спробуйте пізніше або зателефонуйте за номером з оголошення.',
);
const TOO_MANY = propertyNotice(429, 'Забагато спроб', 'Спробуйте через годину.');
const FAILED = propertyNotice(500, 'Щось пішло не так', 'Спробуйте пізніше.');

const KINDS: Readonly<Record<Property['kind'], { label: string; schema: string }>> = {
  apartment: { label: 'Квартира', schema: 'https://schema.org/Apartment' },
  house: { label: 'Будинок', schema: 'https://schema.org/House' },
  commercial: { label: 'Комерційне приміщення', schema: 'https://schema.org/Place' },
  land: { label: 'Земельна ділянка', schema: 'https://schema.org/Place' },
};
const BUSINESS_FUNCTION: Readonly<Record<Property['deal'], string>> = {
  sale: 'http://purl.org/goodrelations/v1#Sell',
  rent: 'http://purl.org/goodrelations/v1#LeaseOut',
};
const SECTIONS = [
  ['condition', 'Стан'],
  ['utilities', 'Комунікації'],
  ['rentTerms', 'Умови оренди'],
  ['purpose', 'Призначення'],
  ['nearby', 'Поруч'],
  ['offer', 'Пропозиція власника'],
  ['cons', 'Чесно про мінуси'],
] as const;
const ERRORS = {
  phone: 'Вкажіть номер телефону, наприклад 067 123 45 67.',
  name: `Ім’я — лише літери, до ${String(MAX_LEAD_NAME)} символів.`,
  consent: 'Поставте позначку згоди, щоб ми могли вам зателефонувати.',
} as const;

const number = (value: number): string =>
  value.toLocaleString('uk-UA', { maximumFractionDigits: 2 }).replace(/\s/g, ' ');

function priceText(property: Property): string {
  const dollars = number(property.priceCents / 100);
  return `$${dollars}${property.deal === 'rent' ? ' / міс.' : ''}${property.negotiable ? ', торг' : ''}`;
}

/** The tags of the address the form carries: a known channel and a material code. */
export interface PageTags {
  readonly channel: PropertyChannel;
  readonly material?: string | undefined;
}

export function tagsOf(query: Readonly<Record<string, string>>): PageTags {
  const material = propertyMaterialSchema.safeParse(query['m'] ?? '');
  return {
    channel: propertyChannelOf(query['c']),
    ...(material.success && material.data !== '' ? { material: material.data } : {}),
  };
}

/**
 * The page of an object: its facts in microdata, the photos, the owner's texts and the lead
 * form. `formEnabled` is false without the privacy contact (`PUBLIC_CONTACT_EMAIL`).
 */
export function renderPropertyPage(
  property: Property,
  photos: readonly PropertyPhotoInfo[],
  options: {
    readonly tags: PageTags;
    readonly formEnabled: boolean;
    readonly error?: keyof typeof ERRORS | undefined;
    readonly status?: number;
  },
): SitePage {
  const e = escapeHtml;
  const kind = KINDS[property.kind];
  const deal = property.deal === 'sale' ? 'Продаж' : 'Оренда';
  const place = [
    `<span itemprop="addressRegion">${e(property.region)} обл.</span>`,
    `<span itemprop="addressLocality">${e(property.settlement)}</span>`,
    ...(property.street === undefined
      ? []
      : [`<span itemprop="streetAddress">вул. ${e(property.street)}</span>`]),
  ].join(', ');
  const facts = [
    `<li>Площа: <span itemprop="floorSize" itemscope itemtype="https://schema.org/QuantitativeValue"><span itemprop="value">${e(number(property.areaM2))}</span><meta itemprop="unitCode" content="MTK"> м²</span></li>`,
    ...(property.rooms === undefined
      ? []
      : [`<li>Кімнат: <span itemprop="numberOfRooms">${String(property.rooms)}</span></li>`]),
    ...(property.floor === undefined
      ? []
      : [
          `<li>Поверх: ${String(property.floor)}${property.floors === undefined ? '' : ` з ${String(property.floors)}`}</li>`,
        ]),
    ...(property.landSotky === undefined
      ? []
      : [`<li>Ділянка: ${e(number(property.landSotky))} сот.</li>`]),
    ...(property.separateEntrance === true ? ['<li>Окремий вхід</li>'] : []),
  ];
  const sections = SECTIONS.flatMap(([field, title]) => {
    const text = property[field];
    return text === undefined
      ? []
      : [`<h2>${title}</h2>`, ...text.split('\n').map((line) => `<p>${e(line)}</p>`)];
  });
  const photoTags =
    photos.length === 0
      ? []
      : [
          '<div class="photos">',
          ...photos.map(
            (photo) =>
              `<img src="${e(propertyPhotoPath(property.slug, photo.position))}" width="${String(photo.width)}" height="${String(photo.height)}" alt="Фото ${String(photo.position)}" loading="lazy" itemprop="image">`,
          ),
          '</div>',
        ];
  const form = options.formEnabled
    ? [
        '<h2 id="zayavka">Залишити заявку</h2>',
        options.error === undefined ? '' : `<p class="error">${e(ERRORS[options.error])}</p>`,
        `<form method="post" action="${e(propertyPath(property.slug, 'lead'))}">`,
        `<label>Телефон<input type="tel" name="${PROPERTY_FORM_FIELDS.phone}" required maxlength="25" autocomplete="tel" inputmode="tel"></label>`,
        `<label>Ім’я (необов’язково)<input type="text" name="${PROPERTY_FORM_FIELDS.name}" maxlength="${String(MAX_LEAD_NAME)}" autocomplete="given-name"></label>`,
        '<fieldset><legend>Як з вами зв’язатися</legend>',
        `<label><input type="radio" name="${PROPERTY_FORM_FIELDS.way}" value="call" checked> Дзвінок</label>`,
        `<label><input type="radio" name="${PROPERTY_FORM_FIELDS.way}" value="telegram"> Telegram</label>`,
        `<label><input type="radio" name="${PROPERTY_FORM_FIELDS.way}" value="viber"> Viber</label>`,
        '</fieldset>',
        `<div class="hp" aria-hidden="true"><label>Сайт<input name="${PROPERTY_FORM_FIELDS.trap}" tabindex="-1" autocomplete="off"></label></div>`,
        `<input type="hidden" name="${PROPERTY_FORM_FIELDS.channel}" value="${e(options.tags.channel)}">`,
        ...(options.tags.material === undefined
          ? []
          : [
              `<input type="hidden" name="${PROPERTY_FORM_FIELDS.material}" value="${e(options.tags.material)}">`,
            ]),
        `<label><input type="checkbox" name="${PROPERTY_FORM_FIELDS.consent}" value="${CONSENT_VALUE}" required> ` +
          'Погоджуюсь, щоб власник зв’язався зі мною щодо цього об’єкта. Телефон видалять, щойно ' +
          `об’єкт продано чи знято, на мій запит або через ${String(PROPERTY_CONTACT_RETENTION_DAYS)} днів. ` +
          `<a href="${PROPERTY_PRIVACY_PATH}">Конфіденційність</a></label>`,
        '<button type="submit">Надіслати</button>',
        '</form>',
      ]
    : ['<p class="muted">Телефон власника — в оголошенні, з якого ви прийшли.</p>'];

  return documentPage(
    options.status ?? 200,
    `${property.title} — ${priceText(property)}`,
    [
      `<article itemscope itemtype="https://schema.org/Offer">`,
      `<link itemprop="businessFunction" href="${BUSINESS_FUNCTION[property.deal]}">`,
      `<h1 itemprop="name">${e(property.title)}</h1>`,
      `<p class="price"><meta itemprop="priceCurrency" content="USD"><span itemprop="price" content="${(property.priceCents / 100).toFixed(2)}">${e(priceText(property))}</span></p>`,
      ...(property.status === 'under_offer'
        ? [
            '<p class="banner">Зараз тривають переговори. Залиште заявку — повідомимо, якщо об’єкт знову буде вільний.</p>',
          ]
        : []),
      `<div itemprop="itemOffered" itemscope itemtype="${kind.schema}">`,
      `<meta itemprop="name" content="${e(property.title)}">`,
      `<p class="place">${e(kind.label)} · ${deal} · <span itemprop="address" itemscope itemtype="https://schema.org/PostalAddress">${place}<meta itemprop="addressCountry" content="UA"></span></p>`,
      `<ul class="facts">${facts.join('')}</ul>`,
      ...photoTags,
      '</div>',
      ...sections,
      '</article>',
      ...form,
      '<p class="muted">Сторінка власника об’єкта. Без cookies: перегляди рахуються без персональних даних.</p>',
    ],
    {
      index: true,
      description: `${kind.label}, ${deal.toLowerCase()}: ${property.settlement}, ${property.region} обл. ${priceText(property)}.`,
    },
  );
}

/** The privacy notice of the object pages, in Ukrainian (ADR-0016 §10). */
export function propertyPrivacyPage(contactEmail: string | undefined): SitePage {
  if (contactEmail === undefined) return PROPERTY_NOT_FOUND;
  const p = (text: string) => `<p>${escapeHtml(text)}</p>`;
  return documentPage(200, 'Конфіденційність', [
    '<h1>Конфіденційність</h1>',
    p(
      'Сторінки об’єктів рахують перегляди без персональних даних: ми не використовуємо cookies і ' +
        'не зберігаємо вашу IP-адресу чи браузер.',
    ),
    p(
      'Якщо ви залишаєте заявку, ми зберігаємо ваш телефон, ім’я (якщо ви його вказали), зручний ' +
        'спосіб зв’язку, час згоди та об’єкт. Їх бачить лише власник, щоб зв’язатися з вами щодо ' +
        'цього об’єкта. Ми не продаємо і не передаємо їх нікому, крім хостинг-провайдера, який ' +
        'зберігає дані для нас.',
    ),
    p(
      'Телефон видаляється, щойно об’єкт продано, здано чи знято з пропозиції, на ваш запит або ' +
        `через ${String(PROPERTY_CONTACT_RETENTION_DAYS)} днів після заявки — що настане раніше. ` +
        `Щоб видалити свої дані або дізнатися, що ми зберігаємо, напишіть на ${contactEmail}.`,
    ),
  ]);
}

/** Counts views of object pages: people only, a repeat within 30 minutes is not a new view. */
export interface PropertyViewCounter {
  /** Never throws. */
  count(property: Pick<Property, 'id'>, tags: PageTags, visit: SiteVisit): Promise<void>;
}

export function createPropertyViewCounter(options: {
  readonly database: Pick<Database, 'properties'>;
  readonly tracker: Pick<SiteTracker, 'writable'>;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly repeatWindowMs?: number;
  readonly maxPerMinute?: number;
}): PropertyViewCounter {
  const now = options.now ?? Date.now;
  const repeatWindowMs = options.repeatWindowMs ?? 30 * 60_000;
  const maxPerMinute = options.maxPerMinute ?? 600;
  const salt = randomBytes(16);
  const seen = new Map<string, number>();
  let minute = { startMs: 0, count: 0 };
  return {
    async count(property, tags, visit) {
      try {
        if (!isVisit(visit)) return;
        const atMs = now();
        const key = createHash('sha256')
          .update(salt)
          .update(`${property.id}|${visit.address ?? ''}|${visit.userAgent ?? ''}`)
          .digest('base64url');
        const last = seen.get(key);
        if (last !== undefined && atMs - last < repeatWindowMs) return;
        if (atMs - minute.startMs >= 60_000) minute = { startMs: atMs, count: 0 };
        if (minute.count >= maxPerMinute) return;
        if ((await options.tracker.writable()) !== 'ok') return;
        if (seen.size >= 50_000) seen.delete(seen.keys().next().value ?? '');
        seen.set(key, atMs);
        minute = { ...minute, count: minute.count + 1 };
        await options.database.properties.track(
          {
            propertyId: property.id,
            step: 'view',
            channel: tags.channel,
            material: tags.material,
            correlationId: visit.correlationId,
          },
          SITE_TRACKER,
        );
      } catch (error) {
        options.logger.error('property view not counted', { error });
      }
    },
  };
}

export interface PropertyRouteDeps {
  readonly database: Pick<Database, 'repositories' | 'properties' | 'transaction'>;
  readonly tracker: Pick<SiteTracker, 'writable'>;
  readonly views: PropertyViewCounter;
  readonly logger: Logger;
  /** Where people ask to delete their data (`PUBLIC_CONTACT_EMAIL`); without it no form. */
  readonly contactEmail?: string | undefined;
  readonly limiter: SubmissionLimiter;
  readonly now?: () => number;
}

/** The object of a public page, or the page that says it is not there (404) or gone (410). */
async function publicProperty(
  deps: Pick<PropertyRouteDeps, 'database'>,
  slug: string,
): Promise<{ readonly property: Property } | { readonly missing: SitePage }> {
  if (!propertySlugSchema.safeParse(slug).success) return { missing: PROPERTY_NOT_FOUND };
  const property = await deps.database.repositories.properties.getBySlug(slug);
  if (property === undefined || property.status === 'draft') return { missing: PROPERTY_NOT_FOUND };
  if (!PUBLIC_PROPERTY_STATUSES.includes(property.status)) return { missing: PROPERTY_ENDED };
  return { property };
}

/**
 * An object's page (`page`), its lead form (`lead`, POSTed as `form`) and the thanks page.
 * Drafts do not exist (404); closed and withdrawn objects are gone (410).
 */
export async function propertyPage(
  deps: PropertyRouteDeps,
  slug: string,
  step: PropertyStep,
  visit: SiteVisit,
  form?: string,
): Promise<SitePage> {
  const found = await publicProperty(deps, slug);
  if ('missing' in found) return found.missing;
  const { property } = found;
  const formEnabled = deps.contactEmail !== undefined;

  switch (step) {
    case 'page': {
      const tags = tagsOf(visit.query);
      await deps.views.count(property, tags, visit);
      return renderPropertyPage(property, await deps.database.properties.photos(property.id), {
        tags,
        formEnabled,
      });
    }
    case 'lead': {
      if (!formEnabled || form === undefined) {
        return { status: 303, redirect: `${propertyPath(slug)}#zayavka` };
      }
      const parsed = parsePropertyLeadForm(form);
      // A robot gets the same answer as a person and nothing is stored.
      if (parsed.kind === 'trap') return { status: 303, redirect: propertyPath(slug, 'thanks') };
      if (parsed.kind === 'invalid') {
        return renderPropertyPage(property, await deps.database.properties.photos(property.id), {
          tags: tagsOf(Object.fromEntries(new URLSearchParams(form))),
          formEnabled,
          error: parsed.reason,
          status: 400,
        });
      }
      if (!deps.limiter.allow(visit.address)) return TOO_MANY;
      if ((await deps.tracker.writable()) !== 'ok') return PAUSED;
      try {
        await capturePropertyLead(
          deps.database,
          {
            propertyId: property.id,
            phone: parsed.phone,
            name: parsed.name,
            way: parsed.way,
            channel: parsed.channel,
            material: parsed.material,
            at: toTimestamp(new Date((deps.now ?? Date.now)())),
            correlationId: visit.correlationId,
          },
          SITE_TRACKER,
        );
      } catch (error) {
        // No form data in the log.
        deps.logger.error('property lead not recorded', { error });
        return FAILED;
      }
      return { status: 303, redirect: propertyPath(slug, 'thanks') };
    }
    case 'thanks':
      return propertyNotice(
        200,
        'Дякуємо!',
        'Власник зв’яжеться з вами найближчим часом зручним для вас способом.',
      );
  }
}

/** A photo of a public object's page: JPEG bytes, or a status without them. */
export async function propertyPhoto(
  deps: Pick<PropertyRouteDeps, 'database'>,
  slug: string,
  position: number,
): Promise<{ readonly status: number; readonly bytes?: Uint8Array | undefined }> {
  const found = await publicProperty(deps, slug);
  if ('missing' in found) return { status: found.missing.status };
  if (!Number.isInteger(position) || position < 1 || position > 15) return { status: 404 };
  const bytes = await deps.database.properties.photo(found.property.id, position);
  return bytes === undefined ? { status: 404 } : { status: 200, bytes };
}
