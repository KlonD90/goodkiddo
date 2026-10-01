import { describe, expect, it } from 'vitest';

import {
  getUsageCacheReadKeys,
  getUsageCacheWriteKey,
  type ClaudeUsageData,
} from './claude-usage.js';

describe('ClaudeUsageData', () => {
  it('represents the API response structure correctly', () => {
    const data: ClaudeUsageData = {
      five_hour: { utilization: 45.2, resets_at: '2026-03-23T17:00:00Z' },
      seven_day: { utilization: 72.1, resets_at: '2026-03-29T00:00:00Z' },
      seven_day_sonnet: {
        utilization: 60.0,
        resets_at: '2026-03-29T00:00:00Z',
      },
      seven_day_opus: { utilization: 80.0, resets_at: '2026-03-29T00:00:00Z' },
    };

    expect(data.five_hour?.utilization).toBe(45.2);
    expect(data.seven_day?.utilization).toBe(72.1);
    expect(data.seven_day_sonnet?.utilization).toBe(60.0);
    expect(data.seven_day_opus?.utilization).toBe(80.0);
  });

  it('allows partial data (only five_hour)', () => {
    const data: ClaudeUsageData = {
      five_hour: { utilization: 10, resets_at: '2026-03-23T17:00:00Z' },
    };

    expect(data.five_hour?.utilization).toBe(10);
    expect(data.seven_day).toBeUndefined();
  });

  it('prefers account-based cache keys and falls back to token suffixes', () => {
    expect(
      getUsageCacheReadKeys(
        'fixture-oauth-token-SYNTH001',
        0,
        'fixture-oauth-token-SYNTH002',
      ),
    ).toEqual(['account-0', 'SYNTH002', 'SYNTH001']);
  });

  it('writes cache under account key when account index is known', () => {
    expect(getUsageCacheWriteKey('fixture-oauth-token-SYNTH001', 0)).toBe(
      'account-0',
    );
    expect(getUsageCacheWriteKey('fixture-oauth-token-SYNTH001')).toBe(
      'SYNTH001',
    );
  });
});
