import path from 'node:path';
import { getEnv } from './env.js';
import { DEFAULT_FILE_LIMITS } from '../persistence/assistant-file-policy.js';
import { loadVoiceConfig } from './assistant-voice-config.js';
import { loadBrowserConfig } from './assistant-browser-config.js';

function numberSetting(key: string, fallback: number): number {
  const value = Number(getEnv(key) ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${key}`);
  return value;
}
function positiveInteger(key: string, fallback: number): number {
  const value = numberSetting(key, fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${key}`);
  return value;
}
function required(key: string): string {
  const value = getEnv(key)?.trim();
  if (!value) throw new Error(`Set ${key} before starting GoodKiddo`);
  return value;
}
function boundedInteger(
  key: string,
  fallback: number,
  maximum: number,
): number {
  const value = positiveInteger(key, fallback);
  if (value > maximum) throw new Error(`Invalid ${key}`);
  return value;
}
export function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function loadAssistantConfig() {
  const timezone = getEnv('ASSISTANT_TIMEZONE') || 'UTC';
  if (!validTimezone(timezone)) throw new Error('Invalid ASSISTANT_TIMEZONE');
  const baseUrl = required('LLM_BASE_URL').replace(/\/$/, '');
  if (new URL(baseUrl).protocol !== 'https:')
    throw new Error('LLM_BASE_URL must use HTTPS');
  const model = required('LLM_MODEL');
  // Only the documented public free route can run without an API credential.
  // Other endpoint/model combinations retain the existing credential requirement.
  const publicFreeModel =
    baseUrl === 'https://opencode.ai/inference/openai/v1' &&
    model === 'space-bunny-free';
  const apiKey = publicFreeModel
    ? getEnv('LLM_API_KEY')?.trim() || ''
    : required('LLM_API_KEY');
  const posthogKey = getEnv('POSTHOG_PROJECT_KEY');
  const analyticsSalt = getEnv('ANALYTICS_SALT');
  // Incomplete optional analytics stays disabled; never hash unsalted IDs.
  return {
    ...loadBrowserConfig(),
    telegramToken: required('TELEGRAM_BOT_TOKEN'),
    baseUrl,
    apiKey,
    model,
    provider: getEnv('LLM_PROVIDER') || new URL(baseUrl).hostname,
    inputPrice: numberSetting('LLM_INPUT_USD_PER_MILLION', 1),
    outputPrice: numberSetting('LLM_OUTPUT_USD_PER_MILLION', 5),
    monthlyBudget: numberSetting('LLM_MONTHLY_BUDGET_USD', 30),
    maxCalls: positiveInteger('LLM_MAX_CALLS_PER_TASK', 6),
    maxOutputTokens: positiveInteger('LLM_MAX_OUTPUT_TOKENS', 1800),
    dailyTasks: positiveInteger('DAILY_TASKS_PER_USER', 20),
    dailyChatTasks: positiveInteger('DAILY_TASKS_PER_CHAT', 60),
    dailyResearch: positiveInteger('DAILY_RESEARCH_PER_USER', 3),
    dailyChatResearch: positiveInteger('DAILY_RESEARCH_PER_CHAT', 6),
    maxActiveJobs: positiveInteger('MAX_ACTIVE_JOBS_PER_CHAT', 20),
    maxSearches: positiveInteger('MAX_SEARCHES_PER_TASK', 3),
    braveKey: getEnv('BRAVE_SEARCH_API_KEY'),
    searchCost: numberSetting('SEARCH_COST_USD_PER_CALL', 0.01),
    timezone,
    voice: loadVoiceConfig(),
    dbPath: path.resolve(getEnv('ASSISTANT_DB_PATH') || 'store/assistant.db'),
    fileShares: {
      enabled: getEnv('FILE_SHARES_ENABLED') === 'true',
      publicBaseUrl: 'https://app.whosagoodkiddo.me',
    },
    fileLimits: {
      maxFileBytes: boundedInteger(
        'FILE_MAX_BYTES',
        DEFAULT_FILE_LIMITS.maxFileBytes,
        DEFAULT_FILE_LIMITS.maxFileBytes,
      ),
      maxChatBytes: boundedInteger(
        'FILE_CHAT_MAX_BYTES',
        DEFAULT_FILE_LIMITS.maxChatBytes,
        DEFAULT_FILE_LIMITS.maxTotalBytes,
      ),
      maxChatFiles: boundedInteger(
        'FILE_CHAT_MAX_COUNT',
        DEFAULT_FILE_LIMITS.maxChatFiles,
        1000,
      ),
      maxTotalBytes: boundedInteger(
        'FILE_TOTAL_MAX_BYTES',
        DEFAULT_FILE_LIMITS.maxTotalBytes,
        DEFAULT_FILE_LIMITS.maxTotalBytes,
      ),
    },
    botVersion: getEnv('BOT_VERSION') || '0.2.0-prealpha.1',
    posthogKey,
    analyticsSalt,
    analyticsTestMode: getEnv('ANALYTICS_TEST_MODE') === 'true',
    posthogHost: getEnv('POSTHOG_HOST') || 'https://us.i.posthog.com',
    internalUsers: new Set(
      (getEnv('ANALYTICS_INTERNAL_USER_IDS') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    internalChats: new Set(
      (getEnv('ANALYTICS_INTERNAL_CHAT_IDS') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  };
}
export type AssistantConfig = ReturnType<typeof loadAssistantConfig>;
