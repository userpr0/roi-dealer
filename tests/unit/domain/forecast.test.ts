import { describe, expect, it } from 'vitest';
import {
  calibration,
  FORECAST_RULES_VERSION,
  forecastProbability,
  launchForecast,
  MAX_FORECAST_PROBABILITY,
  MIN_FORECAST_PROBABILITY,
} from '@roi-dealer/domain';
import { forecastLines } from '@roi-dealer/command-center';

describe('forecast of a test (phase 25)', () => {
  it('reads the opportunity score as a probability and never says certain', () => {
    expect(forecastProbability(62)).toBe(0.62);
    expect(forecastProbability(100)).toBe(MAX_FORECAST_PROBABILITY);
    expect(forecastProbability(0)).toBe(MIN_FORECAST_PROBABILITY);
    expect(forecastProbability(Number.NaN)).toBe(MIN_FORECAST_PROBABILITY);
  });

  it('keeps the rules version and the inputs the rules saw', () => {
    const signals = {
      score: 71,
      components: { frequency: 20, severity: 15 },
      judgesTotal: 64,
      method: 'landing_page',
      geo: 'US',
      priceCents: 1_200,
      budgetCents: 5_000,
      metric: 'lead',
      target: 20,
    };
    expect(launchForecast(signals)).toEqual({
      rulesVersion: FORECAST_RULES_VERSION,
      probability: 0.71,
      signals,
    });
  });
});

describe('calibration (Brier score)', () => {
  it('compares the forecasts with the facts and leaves out inconclusive results', () => {
    const [v1] = calibration([
      { rulesVersion: 1, probability: 0.8, verdict: 'confirmed' },
      { rulesVersion: 1, probability: 0.6, verdict: 'refuted' },
      { rulesVersion: 1, probability: 0.7, verdict: 'inconclusive' },
      { rulesVersion: 1, probability: 0.5 },
    ]);
    // ((0.8 − 1)² + (0.6 − 0)²) / 2 = (0.04 + 0.36) / 2
    expect(v1).toEqual({
      rulesVersion: 1,
      forecasts: 4,
      resolved: 2,
      expectedRate: 0.7,
      observedRate: 0.5,
      brier: 0.2,
    });
  });

  it('counts each version of the rules on its own, newest first', () => {
    const versions = calibration([
      { rulesVersion: 1, probability: 0.9, verdict: 'refuted' },
      { rulesVersion: 2, probability: 0.3 },
    ]);
    expect(versions.map((item) => [item.rulesVersion, item.resolved, item.brier])).toEqual([
      [2, 0, undefined],
      [1, 1, 0.81],
    ]);
  });

  it('says in /roi how accurate the forecasts are and when new weights can be proposed', () => {
    expect(forecastLines([])).toEqual([
      '🎯 Прогнозы: пока нет — журнал начнётся с первого запущенного теста.',
    ]);
    const lines = forecastLines(
      calibration([
        { rulesVersion: 1, probability: 0.8, verdict: 'confirmed' },
        { rulesVersion: 1, probability: 0.6, verdict: 'refuted' },
      ]),
    );
    expect(lines).toEqual([
      '🎯 Прогнозы (правила v1): тестов 2, с итогом 2\n' +
        'Ожидали успех в 70%, вышло 50% · точность (Brier) 0.20 — монетка 0.25, меньше — лучше',
      'Новые веса оценки — после 20 итогов (сейчас 2).',
    ]);
    const many = Array.from({ length: 20 }, () => ({
      rulesVersion: 1,
      probability: 0.5,
      verdict: 'refuted' as const,
    }));
    expect(forecastLines(calibration(many)).at(-1)).toBe(
      'Итогов достаточно для новых весов оценки — их предложение придёт карточкой.',
    );
  });
});
