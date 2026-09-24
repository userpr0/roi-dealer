import { describe, expect, it } from 'vitest';
import { startService } from '../../support/service-process.js';

describe('bot skeleton process', () => {
  it('starts without any Telegram token, logs its status and exits cleanly', async () => {
    const service = startService('apps/bot/src/main.ts', { NODE_ENV: 'test' });

    await expect(service.waitForExit()).resolves.toEqual({ code: 0, signal: null });
    expect(service.logs).toEqual([
      expect.objectContaining({
        level: 'info',
        service: 'bot',
        message: 'bot skeleton: Telegram integration is not implemented in PHASE 00',
      }),
    ]);
  });
});
