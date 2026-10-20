import { describe, expect, it } from 'vitest';
import { sourcesText } from '@roi-dealer/command-center';
import { SOURCE_CATALOG } from '@roi-dealer/evidence';
import {
  approvePrincipal,
  principalIdSchema,
  proposePrincipal,
  type Actor,
  type Principal,
} from '@roi-dealer/domain';
import { createCtx, ctx, OWNER, SYSTEM } from '../../support/domain.js';

function databaseWith(principals: readonly Principal[]): Parameters<typeof sourcesText>[0] {
  return {
    repositories: {
      principals: {
        getByActor: (actor: Actor) =>
          Promise.resolve(
            principals.find((p) => p.actor.type === actor.type && p.actor.id === actor.id),
          ),
      },
    },
  } as unknown as Parameters<typeof sourcesText>[0];
}

describe('/sources (D-026)', () => {
  it('shows the whole catalog by verdict and whether each allowed source collects', async () => {
    const hackerNews = approvePrincipal(
      proposePrincipal(
        {
          actor: { type: 'integration', id: 'source:hacker-news' },
          displayName: 'Hacker News',
          purpose: 'Collects Ask HN posts',
        },
        createCtx(principalIdSchema, SYSTEM),
      ),
      ctx(OWNER, 1),
    );
    const text = await sourcesText(databaseWith([hackerNews]));

    expect(text).toContain(`📚 Источники в каталоге: ${String(SOURCE_CATALOG.length)}`);
    expect(text).toContain('последняя проверка 20.10.2026');
    expect(text).toContain('• Hacker News — ✅ работает');
    expect(text).toContain('• npm: загрузки пакетов — ещё не подключён');
    for (const entry of SOURCE_CATALOG) expect(text).toContain(entry.name);
    // Groups in a fixed order: allowed, agreement, review, rejected.
    const order = ['✅ Разрешены', '🤝 Нужен договор', '🔎 Ждут проверки', '⛔ Отклонены'].map(
      (title) => text.indexOf(title),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.length).toBeLessThan(4_096);
  });

  it('leaves out empty groups', async () => {
    const allowedOnly = SOURCE_CATALOG.filter((entry) => entry.review.verdict === 'allowed');
    const text = await sourcesText(databaseWith([]), allowedOnly);
    expect(text).toContain('• Hacker News — ещё не подключён');
    expect(text).not.toContain('Отклонены');
  });
});
