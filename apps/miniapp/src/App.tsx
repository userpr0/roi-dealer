import { useEffect, useState, type ReactNode } from 'react';
import { apiAddress } from './api-address';
import {
  loadPanel,
  microUsd,
  share,
  usd,
  type Budget,
  type Cycle,
  type Panel,
  type PanelResult,
  type Test,
} from './panel';
import { telegramApp } from './telegram';

const API_URL = apiAddress(import.meta.env.VITE_API_URL, window.location.search);

/**
 * Owner Command Center (PHASE 13): a read-only view of the panel — decisions waiting, money of
 * the month, running tests and the cycle — from `GET /api/panel`. Decisions stay buttons in the
 * bot; the build holds no secrets, only the API address.
 */
export function App() {
  const [result, setResult] = useState<PanelResult | 'loading'>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void loadPanel(API_URL, telegramApp()?.initData, controller.signal).then((loaded) => {
      if (!controller.signal.aborted) setResult(loaded);
    });
    return () => {
      controller.abort();
    };
  }, [attempt]);

  const refresh = () => {
    setResult('loading');
    setAttempt((value) => value + 1);
  };

  return (
    <main className="panel">
      <header className="top">
        <div>
          <h1>ROI Dealer</h1>
          <p className="muted">Пульт владельца</p>
        </div>
        <button type="button" onClick={refresh} disabled={result === 'loading'}>
          Обновить
        </button>
      </header>
      {result === 'loading' ? <p className="muted">Загрузка…</p> : <Body result={result} />}
    </main>
  );
}

function Body({ result }: { readonly result: PanelResult }) {
  switch (result.kind) {
    case 'ok':
      return <PanelView panel={result.panel} />;
    case 'not_configured':
      return (
        <Notice title="Адрес API не задан">
          Откройте пульт кнопкой «Пульт» слева от поля ввода в чате с ботом. Бот ставит её сам,
          когда у него задан <code>PUBLIC_API_URL</code> — адрес сервиса api (docs/deploy/START.md).
        </Notice>
      );
    case 'outside_telegram':
      return (
        <Notice title="Откройте пульт из бота">
          Данные видны только в Telegram: кнопка меню бота слева от поля ввода. Telegram подписывает
          запрос, и API проверяет, что это владелец.
        </Notice>
      );
    case 'refused':
      return <Notice title={REFUSALS[result.status].title}>{REFUSALS[result.status].text}</Notice>;
    case 'failed':
      return (
        <Notice title="API не отвечает">
          Попробуйте «Обновить» через минуту. Бот работает и без пульта: /status, /economics.
        </Notice>
      );
  }
}

const REFUSALS = {
  401: {
    title: 'Подпись Telegram не принята',
    text: 'Подпись устарела или не от этого бота. Закройте и откройте пульт из бота заново.',
  },
  403: {
    title: 'Пульт доступен только владельцу',
    text: 'Попытка записана в журнал доступа.',
  },
  503: {
    title: 'Пульт ещё не подключён',
    text: 'У сервиса api нет базы данных или токена бота (docs/deploy/api.md).',
  },
} as const;

function Notice({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="card notice">
      <h2>{title}</h2>
      <p>{children}</p>
    </section>
  );
}

function PanelView({ panel }: { readonly panel: Panel }) {
  const { decisions, economics, killSwitch, stats } = panel;
  const waiting = decisions.requests + decisions.opportunities;
  return (
    <>
      <section className={`card status ${killSwitch.running ? 'running' : 'paused'}`}>
        {killSwitch.running
          ? '▶️ Автоматизации работают'
          : `⏸ Автоматизации на паузе${killSwitch.reason === undefined ? '' : `: ${killSwitch.reason}`}`}
      </section>

      <section className="card">
        <h2>Ждут решения: {waiting}</h2>
        <p className="muted">
          Запросы {decisions.requests} · возможности {decisions.opportunities}. Решения — кнопками в
          боте: /decisions.
        </p>
      </section>

      <section className="card">
        <h2>Деньги · {economics.month}</h2>
        <p>
          Расходы месяца: <strong>{usd(economics.totalCostsCents)}</strong>
        </p>
        {economics.budgets.map((budget) => (
          <BudgetBar key={budget.label} budget={budget} />
        ))}
        <Meter
          label={`AI сегодня ${microUsd(economics.aiTodayMicroUsd)} из ${microUsd(economics.aiAllowanceMicroUsd)}`}
          value={share(economics.aiTodayMicroUsd, economics.aiAllowanceMicroUsd)}
          tone={economics.aiTodayMicroUsd >= economics.aiAllowanceMicroUsd ? 'over' : 'ok'}
        />
        <Meter
          label={`Тесты: идут ${economics.tests.active} · потрачено ${usd(economics.tests.spentCents)} из одобренных ${usd(economics.tests.approvedCents)}`}
          value={share(economics.tests.spentCents, economics.tests.approvedCents)}
          tone="ok"
        />
        <dl className="facts">
          <Fact name="Оплаты" value={usd(economics.paymentsCents)} />
          <Fact name="Предзаказы" value={usd(economics.preordersCents)} />
          <Fact name="Возвраты" value={usd(economics.refundsCents)} />
          <Fact name="Клиенты" value={String(economics.customers)} />
          <Fact name="ROI" value={percent(economics.roiPercent)} />
          <Fact
            name="Цена проверенной гипотезы"
            value={
              economics.costPerTestedHypothesisCents === undefined
                ? '—'
                : usd(economics.costPerTestedHypothesisCents)
            }
          />
        </dl>
      </section>

      <section className="card">
        <h2>Тесты: {panel.experiments.length}</h2>
        {panel.experiments.length === 0 ? (
          <p className="muted">Незавершённых тестов нет. Их запускают в боте: /experiments.</p>
        ) : (
          panel.experiments.map((test) => <TestCard key={test.number} test={test} />)
        )}
      </section>

      <section className="card">
        <h2>Цикл</h2>
        <CycleTable days={stats.days} recent={stats.recent} allTime={stats.allTime} />
        <dl className="facts">
          <Fact
            name="От сигнала до решения (медиана)"
            value={
              stats.decisionLatencyDays === undefined ? '—' : `${stats.decisionLatencyDays} дн.`
            }
          />
          <Fact name={`Новых знаний за ${stats.days} дней`} value={String(stats.newKnowledge)} />
        </dl>
      </section>

      <p className="muted small">
        Данные из базы на {new Date(panel.generatedAt).toLocaleString('ru-RU')} · только просмотр
      </p>
    </>
  );
}

function percent(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value)}%`;
}

function BudgetBar({ budget }: { readonly budget: Budget }) {
  return (
    <Meter
      label={`${budget.label} ${usd(budget.spentCents)} из ${usd(budget.limitCents)}`}
      value={share(budget.spentCents, budget.limitCents)}
      tone={budget.state}
    />
  );
}

function Meter({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: 'ok' | 'warning' | 'over';
}) {
  return (
    <div className="meter">
      <span>{label}</span>
      <div
        className="bar"
        role="meter"
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <span className={tone} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function Fact({ name, value }: { readonly name: string; readonly value: string }) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function TestCard({ test }: { readonly test: Test }) {
  const spentTone =
    test.spentCents >= test.budgetCents
      ? 'over'
      : test.spentCents >= test.stopLossCents
        ? 'warning'
        : 'ok';
  return (
    <article className="test">
      <h3>
        №{test.number} «{test.title}»
      </h3>
      <p className="muted">
        {test.method} · {test.status}
        {test.overdue ? ' · ⏰ срок вышел' : ''}
      </p>
      {test.day === undefined ? null : (
        <Meter
          label={`День ${Math.min(test.day, test.days)} из ${test.days}`}
          value={share(test.day, test.days)}
          tone={test.overdue ? 'over' : 'ok'}
        />
      )}
      <p>
        Метрика: {test.metric} · сейчас {test.value === undefined ? '—' : test.value}{' '}
        {test.reached ? '✅' : ''}
      </p>
      <Meter
        label={`Потрачено ${usd(test.spentCents)} из ${usd(test.budgetCents)} · stop-loss ${usd(test.stopLossCents)}`}
        value={share(test.spentCents, test.budgetCents)}
        tone={spentTone}
      />
      <p className="muted">
        Выручка {usd(test.revenueCents)} · клиентов {test.customers} · ROI{' '}
        {percent(test.roiPercent)}
      </p>
    </article>
  );
}

const CYCLE_ROWS: readonly (readonly [string, (cycle: Cycle) => string])[] = [
  ['Доказательства', (cycle) => String(cycle.evidence)],
  ['Сигналы', (cycle) => String(cycle.signals)],
  ['Боли (подтверждено)', (cycle) => `${cycle.pains} (${cycle.painsValidated})`],
  ['Возможности', (cycle) => String(cycle.opportunities)],
  ['· на решении', (cycle) => String(cycle.opportunitiesUnderReview)],
  ['· в работе', (cycle) => String(cycle.opportunitiesInWork)],
  ['Гипотезы', (cycle) => String(cycle.hypotheses)],
  ['Тесты запущено', (cycle) => String(cycle.experimentsStarted)],
  ['Тесты завершено', (cycle) => String(cycle.experimentsCompleted)],
  ['Клиенты', (cycle) => String(cycle.customers)],
  ['Выручка', (cycle) => usd(cycle.revenueCents)],
];

function CycleTable({
  days,
  recent,
  allTime,
}: {
  readonly days: number;
  readonly recent: Cycle;
  readonly allTime: Cycle;
}) {
  return (
    <table className="cycle">
      <thead>
        <tr>
          <th />
          <th>{days} дней</th>
          <th>всего</th>
        </tr>
      </thead>
      <tbody>
        {CYCLE_ROWS.map(([name, read]) => (
          <tr key={name}>
            <th scope="row">{name}</th>
            <td>{read(recent)}</td>
            <td>{read(allTime)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
