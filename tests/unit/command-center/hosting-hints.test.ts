import { describe, expect, it } from 'vitest';
import {
  aiKeyText,
  backupStatusLine,
  HOSTING_HINTS,
  HOSTINGS,
  silentText,
  versionText,
} from '@roi-dealer/command-center';
import { toTimestamp } from '@roi-dealer/domain';

const NOW = Date.parse('2026-11-04T10:00:00Z');
const lastSeen = toTimestamp(new Date(NOW - 15 * 60_000));

describe('watchdog hints per host (D-029, D-032)', () => {
  it('names Railway’s own steps while the services run there', () => {
    expect(silentText('worker', lastSeen, NOW, 'railway')).toContain(
      'Railway → worker → Deployments → ⋮ у последнего деплоя → Restart',
    );
    expect(versionText('api', 'abc1234', 'def5678', 'railway')).toContain('⋮ → Redeploy');
    expect(aiKeyText('google', 3, 'railway')).toContain(
      'Railway → worker → Variables → GEMINI_API_KEY',
    );
    expect(backupStatusLine([], NOW, 'railway')).toBe(
      '💾 Бэкап: на Railway — вкладка Backups сервиса Postgres (deploy/START.md)',
    );
  });

  it('keeps the Hetzner steps by default and never mixes the hosts', () => {
    expect(silentText('worker', lastSeen, NOW)).toContain('Hetzner → сервер → Power → Reboot');
    expect(aiKeyText('google', 3)).toContain('deploy/hetzner.md, «Заменить ключ»');
    for (const host of HOSTINGS) {
      const other = host === 'railway' ? 'Hetzner' : 'Railway';
      for (const text of [
        silentText('api', lastSeen, NOW, host),
        versionText('api', 'a', 'b', host),
        aiKeyText('openai', 1, host),
      ]) {
        expect(text).not.toContain(other);
      }
      expect(HOSTING_HINTS[host].guide).toMatch(/^deploy\//);
    }
  });
});
