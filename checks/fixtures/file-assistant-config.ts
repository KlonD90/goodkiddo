import type { AssistantConfig } from '../../src/config/assistant-config.ts';
import { DEFAULT_FILE_LIMITS } from '../../src/persistence/assistant-file-policy.ts';
import { DEFAULT_VOICE_CONFIG } from '../../src/config/assistant-voice-config.ts';

export function fileConfig(): AssistantConfig {
  return {
    telegramToken: 'synthetic-test-credential',
    baseUrl: 'https://example.invalid/v1',
    apiKey: '',
    model: 'synthetic',
    provider: 'synthetic',
    inputPrice: 0,
    outputPrice: 0,
    monthlyBudget: 0,
    maxCalls: 6,
    maxOutputTokens: 1000,
    dailyTasks: 20,
    dailyChatTasks: 60,
    dailyResearch: 3,
    dailyChatResearch: 6,
    maxActiveJobs: 20,
    maxSearches: 3,
    braveKey: undefined,
    searchCost: 0,
    timezone: 'UTC',
    voice: { ...DEFAULT_VOICE_CONFIG },
    dbPath: ':memory:',
    fileLimits: { ...DEFAULT_FILE_LIMITS },
    fileShares: {
      enabled: false,
      publicBaseUrl: 'https://app.whosagoodkiddo.me',
    },
    botVersion: 'test',
    posthogKey: undefined,
    analyticsSalt: undefined,
    analyticsTestMode: true,
    posthogHost: 'https://example.invalid',
    internalUsers: new Set(),
    internalChats: new Set(),
  };
}
