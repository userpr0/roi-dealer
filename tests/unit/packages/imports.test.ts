import { describe, expect, it } from 'vitest';
import * as agents from '@roi-dealer/agents';
import * as aiRuntime from '@roi-dealer/ai-runtime';
import * as brain from '@roi-dealer/brain';
import * as database from '@roi-dealer/database';
import * as domain from '@roi-dealer/domain';
import * as economics from '@roi-dealer/economics';
import * as events from '@roi-dealer/events';
import * as evidence from '@roi-dealer/evidence';
import * as judges from '@roi-dealer/judges';
import * as observability from '@roi-dealer/observability';
import * as opportunities from '@roi-dealer/opportunities';
import * as policies from '@roi-dealer/policies';
import * as rewards from '@roi-dealer/rewards';
import * as schemas from '@roi-dealer/schemas';
import * as shared from '@roi-dealer/shared';
import * as signals from '@roi-dealer/signals';
import * as skills from '@roi-dealer/skills';
import * as telegram from '@roi-dealer/telegram';

describe('workspace packages', () => {
  it.each([
    ['@roi-dealer/agents', agents],
    ['@roi-dealer/ai-runtime', aiRuntime],
    ['@roi-dealer/brain', brain],
    ['@roi-dealer/database', database],
    ['@roi-dealer/domain', domain],
    ['@roi-dealer/economics', economics],
    ['@roi-dealer/events', events],
    ['@roi-dealer/evidence', evidence],
    ['@roi-dealer/judges', judges],
    ['@roi-dealer/observability', observability],
    ['@roi-dealer/opportunities', opportunities],
    ['@roi-dealer/policies', policies],
    ['@roi-dealer/rewards', rewards],
    ['@roi-dealer/schemas', schemas],
    ['@roi-dealer/shared', shared],
    ['@roi-dealer/signals', signals],
    ['@roi-dealer/skills', skills],
    ['@roi-dealer/telegram', telegram],
  ])('%s is importable and identifies itself', (name, module) => {
    expect(module.PACKAGE_NAME).toBe(name);
  });

  it('shared exposes its public surface', () => {
    expect(typeof shared.loadConfig).toBe('function');
    expect(typeof shared.createShutdownManager).toBe('function');
  });
});
