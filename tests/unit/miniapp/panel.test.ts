import { describe, expect, it } from 'vitest';
import { panelGate } from '../../../apps/miniapp/src/gate.js';

describe('Mini App panel outside Telegram', () => {
  it('tells nothing about the setup to a browser without the Telegram signature', () => {
    expect(panelGate(undefined, undefined)).toBe('outside_telegram');
    expect(panelGate('https://api.example.test', '')).toBe('outside_telegram');
    expect(panelGate(undefined, 'query_id=1')).toBe('not_configured');
    expect(panelGate('https://api.example.test', 'query_id=1')).toBeUndefined();
  });
});
