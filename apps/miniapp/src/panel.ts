/*
 * The panel as `GET /api/panel` returns it (PHASE 13, ADR-0008) — mirrors `PanelSnapshot` of
 * @roi-dealer/command-center. Money is in cents (USD), AI in micro-USD. The Mini App only shows
 * it: every decision stays a button in the bot.
 */

export interface Cycle {
  readonly evidence: number;
  readonly signals: number;
  readonly pains: number;
  readonly painsValidated: number;
  readonly opportunities: number;
  readonly opportunitiesUnderReview: number;
  readonly opportunitiesInWork: number;
  readonly hypotheses: number;
  readonly experimentsStarted: number;
  readonly experimentsCompleted: number;
  readonly customers: number;
  readonly revenueCents: number;
}

export interface Budget {
  readonly label: string;
  readonly spentCents: number;
  readonly limitCents: number;
  readonly state: 'ok' | 'warning' | 'over';
}

export interface Test {
  readonly number: number;
  readonly title: string;
  readonly method: string;
  readonly status: string;
  readonly day?: number;
  readonly days: number;
  readonly overdue: boolean;
  readonly metric: string;
  readonly value?: number;
  readonly reached: boolean;
  readonly spentCents: number;
  readonly budgetCents: number;
  readonly stopLossCents: number;
  readonly revenueCents: number;
  readonly customers: number;
  readonly roiPercent?: number;
}

export interface Panel {
  readonly generatedAt: string;
  readonly killSwitch: { readonly running: boolean; readonly reason?: string };
  readonly decisions: { readonly requests: number; readonly opportunities: number };
  readonly economics: {
    readonly month: string;
    readonly totalCostsCents: number;
    readonly budgets: readonly Budget[];
    readonly aiTodayMicroUsd: number;
    readonly aiAllowanceMicroUsd: number;
    readonly tests: {
      readonly active: number;
      readonly approvedCents: number;
      readonly spentCents: number;
    };
    readonly paymentsCents: number;
    readonly preordersCents: number;
    readonly refundsCents: number;
    readonly customers: number;
    readonly roiPercent?: number;
    readonly costPerTestedHypothesisCents?: number;
  };
  readonly experiments: readonly Test[];
  readonly stats: {
    readonly days: number;
    readonly recent: Cycle;
    readonly allTime: Cycle;
    readonly decisionLatencyDays?: number;
    readonly newKnowledge: number;
  };
}

export type PanelResult =
  | { readonly kind: 'ok'; readonly panel: Panel }
  /** No API address: neither `VITE_API_URL` nor the `api` parameter (`apiAddress`). */
  | { readonly kind: 'not_configured' }
  /** Opened in a browser, not from the bot: there is no Telegram signature. */
  | { readonly kind: 'outside_telegram' }
  | { readonly kind: 'refused'; readonly status: 401 | 403 | 503 }
  | { readonly kind: 'failed' };

/** Reads the panel with the Telegram signature as `Authorization: tma <initData>`. */
export async function loadPanel(
  apiUrl: string | undefined,
  initData: string | undefined,
  signal?: AbortSignal,
): Promise<PanelResult> {
  if (apiUrl === undefined || apiUrl.trim() === '') return { kind: 'not_configured' };
  if (initData === undefined || initData === '') return { kind: 'outside_telegram' };
  try {
    const response = await fetch(`${apiUrl.trim().replace(/\/+$/, '')}/api/panel`, {
      headers: { authorization: `tma ${initData}` },
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 401 || response.status === 403 || response.status === 503) {
      return { kind: 'refused', status: response.status };
    }
    if (!response.ok) return { kind: 'failed' };
    return { kind: 'ok', panel: (await response.json()) as Panel };
  } catch {
    return { kind: 'failed' };
  }
}

export function usd(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function microUsd(micro: number): string {
  return usd(Math.round(micro / 10_000));
}

/** Share of `part` in `whole` for a bar, 0–100. */
export function share(part: number, whole: number): number {
  if (whole <= 0) return part > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, (part / whole) * 100));
}
