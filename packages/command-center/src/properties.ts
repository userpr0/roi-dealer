import { randomBytes } from 'node:crypto';
import {
  createProperty,
  libraryPath,
  newLibraryNodes,
  newPropertySchema,
  propertyIdSchema,
  propertyLifecycle,
  propertySlug,
  setPropertyStatus,
  timestampMs,
  withLibraryNodes,
  type Actor,
  type NewProperty,
  type PropertyChannel,
  type PropertyFunnelStep,
  type Property,
  type PropertyKind,
  type PropertyStatus,
  type Timestamp,
} from '@roi-dealer/domain';
import {
  storeLibraryNodes,
  type Database,
  type PropertyFunnelCount,
  type PropertyLead,
} from '@roi-dealer/database';
import { uuidv7 } from '@roi-dealer/shared';
import {
  callbackButton,
  type CallbackContext,
  type CommandContext,
  type InlineKeyboardButton,
} from '@roi-dealer/telegram';
import { CONFIRMATION_TTL_MS } from './kill-switch.js';
import { formatTime, shorten } from './texts.js';

/*
 * /property and /properties (phase 36, ADR-0016 part 2): the owner adds an own object with a
 * pasted form, sees the objects and lists, sells or withdraws them — each with confirmation and
 * one `database.command`. The object goes to the library by code: «Недвижимость › населённый
 * пункт › объект».
 */

export const PROPERTY_PREFIX = 'pr';
export const PROPERTY_VERTICAL = 'Недвижимость';

const MAX_PENDING = 20;
const SHOWN_PROPERTIES = 8;

type Keyboard = (readonly InlineKeyboardButton[])[];

/** The form the owner fills in; the keys are matched without case. */
export const PROPERTY_FORM = [
  '/property',
  'Название: Тетиев, Соборна, 42 м², аренда',
  'Тип: квартира | дом | коммерция | земля',
  'Сделка: продажа | аренда',
  'Область: Киевская',
  'Населённый пункт: Тетиев',
  'Улица: Соборна (без номера дома)',
  'Площадь: 42',
  'Комнаты: 2',
  'Этаж: 1/2',
  'Участок: 6 (соток)',
  'Отдельный вход: да',
  'Цена: 250 (в $; для аренды — в месяц)',
  'Торг: да',
  'Состояние: …',
  'Коммуникации: …',
  'Аренда: срок, депозит, коммуналка',
  'Назначение: для коммерции',
  'Рядом: …',
  'Предложение: …',
  'Минусы: …',
].join('\n');

const FORM_HELP = [
  '🏠 Новый объект: скопируйте анкету, заполните и отправьте одним сообщением.',
  'Обязательно: название, тип, сделка, область, населённый пункт, площадь, цена. Лишние строки удалите.',
  'Тексты пойдут на страницу объекта — пишите по-украински. Без телефонов, ссылок и номера дома: контакт добавит система.',
  '',
  PROPERTY_FORM,
].join('\n');

const KIND_WORDS: Readonly<Record<string, PropertyKind>> = {
  квартира: 'apartment',
  дом: 'house',
  будинок: 'house',
  коммерция: 'commercial',
  комерція: 'commercial',
  коммерческая: 'commercial',
  земля: 'land',
  участок: 'land',
  ділянка: 'land',
};
const KIND_LABELS: Readonly<Record<PropertyKind, string>> = {
  apartment: 'Квартира',
  house: 'Дом',
  commercial: 'Коммерция',
  land: 'Земля',
};
const DEAL_WORDS: Readonly<Record<string, Property['deal']>> = {
  продажа: 'sale',
  продаж: 'sale',
  аренда: 'rent',
  оренда: 'rent',
};
const STATUS_LABELS: Readonly<Record<PropertyStatus, string>> = {
  draft: '📝 черновик',
  listed: '📢 в продаже',
  under_offer: '🤝 торг или задаток',
  closed: '✅ сделка',
  withdrawn: '🗑 снят',
};
const ACTIONS: Readonly<
  Record<'l' | 'u' | 'c' | 'w', { status: PropertyStatus; label: string; question: string }>
> = {
  l: { status: 'listed', label: '📢 В продажу', question: 'Выставить в продажу' },
  u: { status: 'under_offer', label: '🤝 Торг', question: 'Отметить торг или задаток' },
  c: {
    status: 'closed',
    label: '✅ Сделка',
    question: 'Отметить сделку — объект закрыт, страница уйдёт, телефоны заявок удалятся',
  },
  w: {
    status: 'withdrawn',
    label: '🗑 Снять',
    question: 'Снять объект — страница уйдёт, телефоны заявок удалятся',
  },
};
const ACTION_OF: Readonly<Record<PropertyStatus, keyof typeof ACTIONS | undefined>> = {
  draft: undefined,
  listed: 'l',
  under_offer: 'u',
  closed: 'c',
  withdrawn: 'w',
};

const FIELD_KEYS: Readonly<Record<string, string>> = {
  название: 'title',
  тип: 'kind',
  сделка: 'deal',
  область: 'region',
  'населенный пункт': 'settlement',
  город: 'settlement',
  село: 'settlement',
  улица: 'street',
  площадь: 'area',
  комнаты: 'rooms',
  этаж: 'floor',
  участок: 'land',
  'отдельный вход': 'entrance',
  цена: 'price',
  торг: 'negotiable',
  состояние: 'condition',
  коммуникации: 'utilities',
  аренда: 'rentTerms',
  назначение: 'purpose',
  рядом: 'nearby',
  предложение: 'offer',
  минусы: 'cons',
};
const LABELS: Readonly<Record<string, string>> = {
  title: 'Название',
  kind: 'Тип',
  deal: 'Сделка',
  region: 'Область',
  settlement: 'Населённый пункт',
  street: 'Улица',
  areaM2: 'Площадь',
  rooms: 'Комнаты',
  floor: 'Этаж',
  floors: 'Этаж',
  landSotky: 'Участок',
  separateEntrance: 'Отдельный вход',
  priceCents: 'Цена',
  negotiable: 'Торг',
  condition: 'Состояние',
  utilities: 'Коммуникации',
  rentTerms: 'Аренда',
  purpose: 'Назначение',
  nearby: 'Рядом',
  offer: 'Предложение',
  cons: 'Минусы',
};

const keyOf = (text: string): string =>
  text.trim().toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ');

/** «42», «42,5», «42.5 м²» → 42.5. */
function numberOf(text: string): number | undefined {
  const match = /^-?\d+(?:[.,]\d+)?/.exec(text.replace(/\s+/g, ''));
  return match === null ? undefined : Number(match[0].replace(',', '.'));
}

/** «да» / «нет» (and their Ukrainian forms). */
function yesNo(text: string): boolean | undefined {
  const word = keyOf(text);
  if (['да', 'так', 'есть', 'є'].includes(word)) return true;
  if (['нет', 'ні'].includes(word)) return false;
  return undefined;
}

/** A price in dollars → cents; another currency is refused (D-005: money only in USD). */
function priceCentsOf(text: string): number | undefined | 'currency' {
  if (/грн|₴|uah|гривен|€|eur|руб/i.test(text)) return 'currency';
  const digits = text.replace(/[$\s]/g, '').replace(/usd|долл\S*|дол\S*/gi, '');
  if (!/^\d{1,3}(?:[,.]?\d{3})*(?:[.,]\d{1,2})?$/.test(digits)) return undefined;
  // «25,000» and «25.000» are thousands; «250,50» and «250.5» are cents.
  const cents = /[.,]\d{1,2}$/.exec(digits);
  const whole = (cents === null ? digits : digits.slice(0, -cents[0].length)).replace(/[.,]/g, '');
  const fraction = cents === null ? 0 : Number(cents[0].slice(1).padEnd(2, '0'));
  return Number(whole) * 100 + fraction;
}

export type PropertyForm =
  | { readonly ok: true; readonly data: Omit<NewProperty, 'slug'> }
  | { readonly ok: false; readonly errors: readonly string[] };

/** The owner's pasted form → the fields of a new object, checked by the domain schema. */
export function parsePropertyForm(text: string): PropertyForm {
  const values = new Map<string, string>();
  const errors: string[] = [];
  let current: string | undefined;
  for (const line of text.split('\n')) {
    const match = /^\s*([^:]{2,30}):\s*(.*)$/.exec(line);
    const field = match === null ? undefined : FIELD_KEYS[keyOf(match[1] ?? '')];
    if (match !== null && field !== undefined) {
      current = field;
      values.set(field, (match[2] ?? '').trim());
    } else if (match !== null && current === undefined) {
      errors.push(`Непонятная строка: «${shorten(line.trim(), 40)}»`);
    } else if (current !== undefined && line.trim() !== '') {
      values.set(current, `${values.get(current) ?? ''}\n${line.trim()}`.trim());
    }
  }
  const text_ = (field: string): string | undefined => {
    const value = values.get(field)?.trim();
    return value === undefined || value === '' || value === '…' ? undefined : value;
  };

  const kindText = text_('kind');
  const kind = kindText === undefined ? undefined : KIND_WORDS[keyOf(kindText)];
  if (kind === undefined) errors.push('Тип: квартира, дом, коммерция или земля.');
  const dealText = text_('deal');
  const deal = dealText === undefined ? undefined : DEAL_WORDS[keyOf(dealText)];
  if (deal === undefined) errors.push('Сделка: продажа или аренда.');
  const area = text_('area') === undefined ? undefined : numberOf(text_('area') ?? '');
  if (area === undefined) errors.push('Площадь: число в м², например 42 или 42,5.');
  const priceText = text_('price');
  const price = priceText === undefined ? undefined : priceCentsOf(priceText);
  if (price === 'currency') errors.push('Цена — только в $ (учёт в долларах).');
  else if (price === undefined) errors.push('Цена: сумма в $, например 25000 или 250.');
  const floorText = text_('floor');
  const [floor, floors] = (floorText ?? '').split('/').map((part) => numberOf(part));
  const optionalBoolean = (field: string, label: string): boolean | undefined => {
    const value = text_(field);
    if (value === undefined) return undefined;
    const parsed = yesNo(value);
    if (parsed === undefined) errors.push(`${label}: да или нет.`);
    return parsed;
  };
  const separateEntrance = optionalBoolean('entrance', 'Отдельный вход');
  const negotiable = optionalBoolean('negotiable', 'Торг') ?? false;
  const roomsText = text_('rooms');
  const landText = text_('land');
  if (errors.length > 0) return { ok: false, errors };

  const data = {
    title: text_('title'),
    kind,
    deal,
    region: text_('region'),
    settlement: text_('settlement'),
    street: text_('street'),
    areaM2: area,
    rooms: roomsText === undefined ? undefined : numberOf(roomsText),
    floor: floorText === undefined ? undefined : floor,
    floors: floorText === undefined ? undefined : floors,
    landSotky: landText === undefined ? undefined : numberOf(landText),
    separateEntrance,
    priceCents: price,
    negotiable,
    condition: text_('condition'),
    utilities: text_('utilities'),
    rentTerms: text_('rentTerms'),
    purpose: text_('purpose'),
    nearby: text_('nearby'),
    offer: text_('offer'),
    cons: text_('cons'),
  };
  const checked = newPropertySchema.safeParse({
    ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    slug: 'proverka',
  });
  if (!checked.success) {
    return {
      ok: false,
      errors: [
        ...new Set(
          checked.error.issues.map((issue) => {
            const label = LABELS[String(issue.path[0])] ?? String(issue.path[0]);
            return issue.code === 'invalid_type'
              ? `${label}: обязательное поле.`
              : `${label}: ${issueText(issue.message)}`;
          }),
        ),
      ],
    };
  }
  const { slug: _slug, ...fields } = checked.data;
  return { ok: true, data: fields };
}

function issueText(message: string): string {
  if (message.includes('house number')) return 'без номера дома.';
  if (message.includes('phone numbers'))
    return 'без телефонов, почты и ссылок — контакт добавит система.';
  if (message.includes('one line')) return 'в одну строку.';
  if (message.includes('floor')) return 'этаж выше этажности.';
  if (message.includes('rent terms')) return 'только для аренды.';
  return 'проверьте значение.';
}

const dollars = (cents: number): string => {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return `$${whole.toLocaleString('en-US')}${rest === 0 ? '' : `.${String(rest).padStart(2, '0')}`}`;
};

/** The card of an object: what the page will say, in the owner's words. */
export function propertyCard(
  property: Omit<NewProperty, 'slug'> & Partial<Pick<Property, 'status' | 'slug'>>,
): string {
  const place = [
    `${property.region} обл.`,
    property.settlement,
    ...(property.street === undefined ? [] : [`ул. ${property.street}`]),
  ].join(', ');
  const facts = [
    `${String(property.areaM2)} м²`,
    ...(property.rooms === undefined ? [] : [`комнат: ${String(property.rooms)}`]),
    ...(property.floor === undefined
      ? []
      : [
          `этаж ${String(property.floor)}${property.floors === undefined ? '' : `/${String(property.floors)}`}`,
        ]),
    ...(property.landSotky === undefined ? [] : [`участок ${String(property.landSotky)} сот.`]),
    ...(property.separateEntrance === true ? ['отдельный вход'] : []),
  ];
  const price = `${dollars(property.priceCents)}${property.deal === 'rent' ? ' в месяц' : ''}${property.negotiable ? ', торг' : ''}`;
  const texts = (
    [
      ['Состояние', property.condition],
      ['Коммуникации', property.utilities],
      ['Аренда', property.rentTerms],
      ['Назначение', property.purpose],
      ['Рядом', property.nearby],
      ['Предложение', property.offer],
      ['Честно о минусах', property.cons],
    ] as const
  ).flatMap(([label, value]) => (value === undefined ? [] : [`${label}: ${shorten(value, 300)}`]));
  return [
    `🏠 ${property.title}${property.status === undefined ? '' : ` — ${STATUS_LABELS[property.status]}`}`,
    `${KIND_LABELS[property.kind]} · ${property.deal === 'sale' ? 'продажа' : 'аренда'} · ${place}`,
    facts.join(' · '),
    `Цена: ${price}`,
    ...texts,
  ].join('\n');
}

const WAY_LABELS = { call: 'звонок', telegram: 'Telegram', viber: 'Viber' } as const;
const CHANNEL_LABELS: Readonly<Record<PropertyChannel, string>> = {
  olx: 'OLX',
  domria: 'DOM.RIA',
  fb: 'Facebook',
  tg: 'Telegram',
  viber: 'Viber',
  ig: 'Instagram',
  tt: 'TikTok',
  other: 'другое',
};
/** The owner's steps after a lead: a call, a showing, a deal. */
const OWNER_STEPS: Readonly<
  Record<'c' | 's' | 'd', { step: PropertyFunnelStep; label: string; question: string }>
> = {
  c: { step: 'call', label: '📞 Созвонились', question: 'Записать звонок' },
  s: { step: 'showing', label: '👀 Показ', question: 'Записать показ' },
  d: { step: 'deal', label: '🤝 Сделка', question: 'Записать сделку по этой заявке' },
};

const tagText = (lead: Pick<PropertyLead, 'channel' | 'material'>): string =>
  `${CHANNEL_LABELS[lead.channel]}${lead.material === undefined ? '' : ` · материал ${lead.material}`}`;

/** The notice of a new lead of an object page: no phone — it is behind a button (ADR-0016 §12). */
export function propertyLeadText(lead: PropertyLead, property: Pick<Property, 'title'>): string {
  return [
    `📥 Заявка на «${shorten(property.title, 100)}» · ${formatTime(lead.occurredAt)}`,
    `Канал: ${tagText(lead)}${lead.preferred === undefined ? '' : ` · удобно: ${WAY_LABELS[lead.preferred]}`}`,
    lead.preferred === undefined ? 'Телефон уже удалён.' : 'Телефон — по кнопке, только вам.',
  ].join('\n');
}

export function propertyLeadKeyboard(lead: Pick<PropertyLead, 'id' | 'preferred'>): Keyboard {
  const id = String(lead.id);
  return [
    ...(lead.preferred === undefined
      ? []
      : [[callbackButton('📱 Показать контакт', `${PROPERTY_PREFIX}:c:${id}`)]]),
    (Object.keys(OWNER_STEPS) as (keyof typeof OWNER_STEPS)[]).map((code) =>
      callbackButton(OWNER_STEPS[code].label, `${PROPERTY_PREFIX}:f:${id}:${code}`),
    ),
  ];
}

/** «👁 12 · 📥 3 · 📞 1 · 👀 0 · 🤝 0» and the channels that brought leads. */
function countsLine(counts: readonly PropertyFunnelCount[]): string | undefined {
  if (counts.length === 0) return undefined;
  const total = (step: PropertyFunnelStep) =>
    counts.filter((item) => item.step === step).reduce((sum, item) => sum + item.count, 0);
  const leads = new Map<string, number>();
  for (const item of counts.filter((entry) => entry.step === 'lead')) {
    leads.set(
      CHANNEL_LABELS[item.channel],
      (leads.get(CHANNEL_LABELS[item.channel]) ?? 0) + item.count,
    );
  }
  const byChannel = [...leads.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([channel, count]) => `${channel} ${String(count)}`)
    .join(', ');
  return (
    `   👁 ${String(total('view'))} · 📥 ${String(total('lead'))} · 📞 ${String(total('call'))} · ` +
    `👀 ${String(total('showing'))} · 🤝 ${String(total('deal'))}` +
    (byChannel === '' ? '' : ` · заявки: ${byChannel}`)
  );
}

type PropertyStore = Pick<Database, 'repositories' | 'properties'>;

/** /properties: the objects, newest change first, with the next steps of each as buttons. */
export async function propertiesView(
  database: PropertyStore,
): Promise<{ readonly text: string; readonly keyboard?: Keyboard | undefined }> {
  const objects = await database.repositories.properties.listByStatuses([
    'draft',
    'listed',
    'under_offer',
    'closed',
    'withdrawn',
  ]);
  if (objects.length === 0) {
    return { text: `🏠 Объектов пока нет. Добавить — /property` };
  }
  const counts = await database.properties.counts(objects.map((item) => item.id));
  const lines = ['🏠 Свои объекты', ''];
  const keyboard: Keyboard = [];
  objects.forEach((property, index) => {
    const number = String(index + 1);
    lines.push(
      `${number}. ${property.title} — ${STATUS_LABELS[property.status]} · ${dollars(property.priceCents)}${property.deal === 'rent' ? '/мес' : ''}`,
    );
    const line = countsLine(counts.filter((item) => item.propertyId === property.id));
    if (line !== undefined) lines.push(line);
    if (index >= SHOWN_PROPERTIES) return;
    const next = propertyLifecycle.nextStates(property.status);
    const buttons = next.flatMap((status) => {
      const code = ACTION_OF[status];
      return code === undefined
        ? []
        : [
            callbackButton(
              `${ACTIONS[code].label} ${number}`,
              `${PROPERTY_PREFIX}:s:${property.id}:${String(property.version)}:${code}`,
            ),
          ];
    });
    if (buttons.length > 0) keyboard.push(buttons);
  });
  lines.push('', 'Добавить объект — /property. Сделку и снятие отменить нельзя.');
  return { text: lines.join('\n'), ...(keyboard.length === 0 ? {} : { keyboard }) };
}

export interface PropertyFlowDeps {
  readonly database: Database;
  readonly now: () => Timestamp;
  readonly owner: (userId: number) => Actor;
}

export interface PropertyFlow {
  readonly property: (context: CommandContext) => Promise<void>;
  readonly properties: (context: CommandContext) => Promise<void>;
  readonly handleButton: (context: CallbackContext) => Promise<void>;
}

type Pending =
  | { readonly kind: 'add'; readonly data: Omit<NewProperty, 'slug'>; readonly expiresAtMs: number }
  | {
      readonly kind: 'status';
      readonly propertyId: string;
      readonly version: number;
      readonly status: PropertyStatus;
      readonly expiresAtMs: number;
    }
  | {
      readonly kind: 'step';
      readonly leadId: number;
      readonly step: PropertyFunnelStep;
      readonly expiresAtMs: number;
    };

const STALE = '⌛ Подтверждение устарело. Повторите /properties.';

export function createPropertyFlow(deps: PropertyFlowDeps): PropertyFlow {
  const { database } = deps;
  const pending = new Map<string, Pending>();
  const nowMs = (): number => timestampMs(deps.now());

  function remember(item: Pending): string {
    const current = nowMs();
    for (const [nonce, entry] of pending) if (entry.expiresAtMs <= current) pending.delete(nonce);
    while (pending.size >= MAX_PENDING) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
    const nonce = randomBytes(8).toString('hex');
    pending.set(nonce, item);
    return nonce;
  }

  const confirm = (nonce: string, yes: string): Keyboard => [
    [
      callbackButton(yes, `${PROPERTY_PREFIX}:y:${nonce}`),
      callbackButton('Отмена', `${PROPERTY_PREFIX}:n:${nonce}`),
    ],
  ];

  return {
    async property(context) {
      if (context.args.trim() === '') {
        await context.reply(FORM_HELP);
        return;
      }
      const form = parsePropertyForm(context.args);
      if (!form.ok) {
        await context.reply(
          ['⛔ Не сохранено — поправьте анкету:', ...form.errors.map((error) => `• ${error}`)].join(
            '\n',
          ),
        );
        return;
      }
      const nonce = remember({
        kind: 'add',
        data: form.data,
        expiresAtMs: nowMs() + CONFIRMATION_TTL_MS,
      });
      await context.reply(
        [
          propertyCard(form.data),
          '',
          `Сохранить как черновик? Он ляжет в библиотеку: ${PROPERTY_VERTICAL} › ${form.data.settlement}. Подтверждение действует 10 минут.`,
        ].join('\n'),
        confirm(nonce, '💾 Сохранить'),
      );
    },

    async properties(context) {
      const view = await propertiesView(database);
      await context.reply(view.text, view.keyboard);
    },

    async handleButton(context) {
      // The router passes the data after `pr:`.
      const [action, first, second, third] = context.data.split(':');

      if (action === 's') {
        const code = third as keyof typeof ACTIONS | undefined;
        const target = code === undefined ? undefined : ACTIONS[code];
        const id = propertyIdSchema.safeParse(first);
        const property = id.success
          ? await database.repositories.properties.getById(id.data)
          : undefined;
        if (
          target === undefined ||
          property === undefined ||
          String(property.version) !== second ||
          !propertyLifecycle.nextStates(property.status).includes(target.status)
        ) {
          await context.edit('Карточка устарела. Повторите /properties.');
          return;
        }
        const nonce = remember({
          kind: 'status',
          propertyId: property.id,
          version: property.version,
          status: target.status,
          expiresAtMs: nowMs() + CONFIRMATION_TTL_MS,
        });
        await context.edit(
          `${target.question}: «${property.title}»? Подтверждение действует 10 минут.`,
          confirm(nonce, 'Да'),
        );
        return;
      }

      // The phone of a lead: only in the owner's chat, never in a log (ADR-0016 §12).
      if (action === 'c') {
        const contact = await database.properties.contact(
          Number(first),
          deps.owner(context.userId),
        );
        if (contact === undefined) {
          await context.answer('Телефон уже удалён.');
          return;
        }
        await context.reply(
          `📱 ${contact.phone}${contact.name === undefined ? '' : ` · ${contact.name}`} · удобно: ${WAY_LABELS[contact.preferred]}`,
        );
        await context.answer('Контакт отправлен');
        return;
      }
      // A call, a showing or a deal after a lead: confirmation first.
      if (action === 'f') {
        const target = OWNER_STEPS[second as keyof typeof OWNER_STEPS] as
          (typeof OWNER_STEPS)[keyof typeof OWNER_STEPS] | undefined;
        const lead =
          target === undefined ? undefined : await database.properties.lead(Number(first));
        const property =
          lead === undefined
            ? undefined
            : await database.repositories.properties.getById(lead.propertyId);
        if (target === undefined || lead === undefined || property === undefined) {
          await context.answer('Заявка не найдена.');
          return;
        }
        const nonce = remember({
          kind: 'step',
          leadId: lead.id,
          step: target.step,
          expiresAtMs: nowMs() + CONFIRMATION_TTL_MS,
        });
        await context.reply(
          `${target.question}: «${shorten(property.title, 100)}» · ${tagText(lead)}? Подтверждение действует 10 минут.`,
          confirm(nonce, 'Да'),
        );
        return;
      }

      if (action === 'n' && first !== undefined) {
        pending.delete(first);
        await context.edit('Отменено. Ничего не записано.');
        return;
      }
      const item = first === undefined ? undefined : pending.get(first);
      if (
        action !== 'y' ||
        first === undefined ||
        item === undefined ||
        item.expiresAtMs <= nowMs()
      ) {
        await context.edit(STALE);
        return;
      }
      const actor = deps.owner(context.userId);
      const correlationId = `tg-update-${String(context.updateId)}`;
      const command = { idempotencyKey: `tg-callback-${context.callbackQueryId}`, correlationId };

      if (item.kind === 'add') {
        const { result } = await database.command(
          { ...command, name: 'property.add' },
          async (scope) => {
            const id = propertyIdSchema.parse(uuidv7());
            const property = createProperty(
              {
                ...item.data,
                slug: propertySlug(item.data.settlement, item.data.deal, id.slice(-4)),
              },
              { id, actor, at: deps.now() },
            );
            await scope.repositories.properties.insert(property);
            // The library by code: «Недвижимость › населённый пункт › объект».
            const tree = await scope.library.tree();
            const nodes = newLibraryNodes(
              tree,
              { vertical: PROPERTY_VERTICAL, project: property.settlement, topic: property.title },
              { actor, at: deps.now() },
              uuidv7,
            );
            if ('rejected' in nodes) return { title: property.title, path: '' };
            await storeLibraryNodes(scope.repositories, nodes);
            await scope.library.file({
              objectType: 'property',
              objectId: property.id,
              topicId: nodes.topic.id,
              actorType: 'owner',
              actorId: actor.id,
              correlationId,
            });
            return {
              title: property.title,
              path: libraryPath(withLibraryNodes(tree, nodes), nodes.topic.id) ?? '',
            };
          },
        );
        pending.delete(first);
        await context.edit(
          [
            `💾 Сохранено как черновик: «${result.title}».`,
            result.path === ''
              ? 'В библиотеку не легло: дерево полно.'
              : `Библиотека: ${result.path}.`,
            'Выставить в продажу — /properties.',
          ].join('\n'),
        );
        return;
      }

      if (item.kind === 'step') {
        await database.command({ ...command, name: 'property.funnel' }, async (scope) => {
          const lead = await scope.properties.lead(item.leadId);
          if (lead === undefined) return { recorded: false };
          await scope.properties.track(
            {
              propertyId: lead.propertyId,
              step: item.step,
              channel: lead.channel,
              material: lead.material,
              leadId: lead.id,
              correlationId,
            },
            actor,
          );
          return { recorded: true };
        });
        pending.delete(first);
        await context.edit(`✅ Записано. Цифры объекта — /properties.`);
        return;
      }

      const { result } = await database.command(
        { ...command, name: 'property.status' },
        async (scope) => {
          const property = await scope.repositories.properties.getById(
            propertyIdSchema.parse(item.propertyId),
          );
          if (property?.version !== item.version) return { title: '', erased: 0 };
          await scope.repositories.properties.update(
            setPropertyStatus(property, item.status, { actor, at: deps.now() }),
            actor,
          );
          // A closed or withdrawn object keeps no phones (ADR-0016 §12).
          const erased =
            item.status === 'closed' || item.status === 'withdrawn'
              ? await scope.properties.eraseContacts(property.id, actor)
              : 0;
          return { title: property.title, erased };
        },
      );
      pending.delete(first);
      await context.edit(
        result.title === ''
          ? 'Карточка устарела: объект уже изменился. Повторите /properties.'
          : `${STATUS_LABELS[item.status]}: «${result.title}».` +
              ((result.erased ?? 0) > 0
                ? ` Телефонов заявок удалено: ${String(result.erased)}.`
                : '') +
              ' Список — /properties.',
      );
    },
  };
}
