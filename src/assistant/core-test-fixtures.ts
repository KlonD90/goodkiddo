import { DEFAULT_FILE_LIMITS } from '../persistence/assistant-file-policy.js';
import { DEFAULT_VOICE_CONFIG } from '../config/assistant-voice-config.js';
import type { AssistantConfig } from '../config/assistant-config.js';
import type { TelegramAssistantApi } from '../channels/telegram-assistant-api.js';

export function syntheticConfig(): AssistantConfig {
  return {
    telegramToken: 'synthetic',
    baseUrl: 'https://invalid.example',
    apiKey: '',
    model: 'fake',
    context: {
      textBudgetEnabled: true,
      windowTokens: 200_000,
      inputTokens: 200_000,
      source: 'synthetic fixture',
    },
    provider: 'fake',
    inputPrice: 0,
    outputPrice: 0,
    monthlyBudget: 0,
    maxCalls: 4,
    maxOutputTokens: 100,
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
    miniPages: { enabled: false },
    botVersion: 'test',
    posthogKey: undefined,
    analyticsSalt: undefined,
    analyticsTestMode: true,
    posthogHost: 'https://invalid.example',
    internalUsers: new Set(),
    internalChats: new Set(),
  };
}
export function syntheticApi(): TelegramAssistantApi {
  return {
    typing: async () => {},
    send: async () => {},
    answer: async () => {},
    call: async () => ({ status: 'administrator' }),
  } as unknown as TelegramAssistantApi;
}
