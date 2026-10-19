import { authorizePanel, createSenderThrottle, panelSnapshot } from '@roi-dealer/command-center';
import type { Database } from '@roi-dealer/database';
import type { Logger } from '@roi-dealer/observability';
import type { PanelRoute } from './router.js';

export interface PanelRouteOptions {
  readonly database: Database;
  readonly botToken: string;
  readonly ownerUserId: number;
  readonly origins: readonly string[];
  readonly logger: Logger;
  readonly now?: () => number;
}

/**
 * `GET /api/panel` (PHASE 13, ADR-0008): the owner's Telegram signature first, then the
 * read-only snapshot. Every owner view is recorded in the access log, a refused Telegram account
 * at most once per 10 minutes (as in the bot); the token and `initData` are never logged.
 */
export function createPanelRoute(options: PanelRouteOptions): PanelRoute {
  const { database, logger } = options;
  const now = options.now ?? Date.now;
  const shouldRecord = createSenderThrottle();
  return {
    origins: options.origins,
    async read(authorization, correlationId) {
      const access = authorizePanel(authorization, {
        botToken: options.botToken,
        ownerUserId: options.ownerUserId,
        nowMs: now(),
      });
      const correlation = correlationId === undefined ? undefined : `miniapp-${correlationId}`;
      if (access.status === 401) {
        logger.warn('mini app request refused', { reason: access.reason });
        return { status: 401, body: { error: 'unauthorized' } };
      }
      if (access.status === 403) {
        const actorId = `telegram:${String(access.userId)}`;
        if (shouldRecord(actorId, now())) {
          await database.access.record({
            channel: 'telegram',
            actorId,
            permission: 'status.read',
            decision: 'denied',
            reason: 'not_owner',
            correlationId: correlation,
          });
        }
        return { status: 403, body: { error: 'forbidden' } };
      }
      await database.access.record({
        channel: 'telegram',
        actorType: access.actor.type,
        actorId: access.actor.id,
        permission: 'status.read',
        decision: 'allowed',
        correlationId: correlation,
      });
      return { status: 200, body: await panelSnapshot(database, now()) };
    },
  };
}
