import { describe, expect, it } from 'vitest';
import { parsePropertyForm, propertyCard } from '@roi-dealer/command-center';

const FORM = [
  'Название: Тетіїв, Соборна, 42 м², оренда',
  'Тип: коммерция',
  'Сделка: аренда',
  'Область: Київська',
  'Населённый пункт: Тетіїв',
  'Улица: Соборна',
  'Площадь: 42,5 м²',
  'Этаж: 1/2',
  'Отдельный вход: да',
  'Цена: $250',
  'Торг: да',
  'Аренда: від 11 місяців,',
  'депозит — один місяць.',
  'Минусы: вхід зі двору.',
].join('\n');

describe('the pasted form of /property (phase 36)', () => {
  it('reads the fields, a value over several lines and the numbers', () => {
    const form = parsePropertyForm(FORM);
    if (!form.ok) throw new Error(form.errors.join('; '));
    expect(form.data).toEqual({
      title: 'Тетіїв, Соборна, 42 м², оренда',
      kind: 'commercial',
      deal: 'rent',
      region: 'Київська',
      settlement: 'Тетіїв',
      street: 'Соборна',
      areaM2: 42.5,
      floor: 1,
      floors: 2,
      separateEntrance: true,
      priceCents: 25_000,
      negotiable: true,
      rentTerms: 'від 11 місяців,\nдепозит — один місяць.',
      cons: 'вхід зі двору.',
    });
    expect(propertyCard(form.data)).toBe(
      [
        '🏠 Тетіїв, Соборна, 42 м², оренда',
        'Коммерция · аренда · Київська обл., Тетіїв, ул. Соборна',
        '42.5 м² · этаж 1/2 · отдельный вход',
        'Цена: $250 в месяц, торг',
        // The card is compact: a text over several lines is one line here.
        'Аренда: від 11 місяців, депозит — один місяць.',
        'Честно о минусах: вхід зі двору.',
      ].join('\n'),
    );
  });

  it('reads prices in dollars only', () => {
    const price = (text: string) => {
      const form = parsePropertyForm(FORM.replace('Цена: $250', `Цена: ${text}`));
      return form.ok ? form.data.priceCents : form.errors;
    };
    expect(price('25 000')).toBe(2_500_000);
    expect(price('$25,000')).toBe(2_500_000);
    expect(price('25.000 USD')).toBe(2_500_000);
    expect(price('250.5')).toBe(25_050);
    expect(price('10 000 грн')).toEqual(['Цена — только в $ (учёт в долларах).']);
    expect(price('дорого')).toEqual(['Цена: сумма в $, например 25000 или 250.']);
  });

  it('names every field to fix', () => {
    const form = parsePropertyForm(
      ['Название: Будинок', 'Тип: вилла', 'Улица: Соборна 42', 'Предложение: 067 123 45 67'].join(
        '\n',
      ),
    );
    expect(form.ok).toBe(false);
    expect(form.ok ? [] : form.errors).toEqual([
      'Тип: квартира, дом, коммерция или земля.',
      'Сделка: продажа или аренда.',
      'Площадь: число в м², например 42 или 42,5.',
      'Цена: сумма в $, например 25000 или 250.',
    ]);
    const second = parsePropertyForm(
      FORM.replace('Улица: Соборна', 'Улица: Соборна 42').replace(
        'Минусы: вхід зі двору.',
        'Минусы: дзвоніть 067 123 45 67',
      ),
    );
    expect(second.ok ? [] : second.errors).toEqual([
      'Улица: без номера дома.',
      'Минусы: без телефонов, почты и ссылок — контакт добавит система.',
    ]);
    expect(parsePropertyForm('Привет: как дела').ok).toBe(false);
  });
});
