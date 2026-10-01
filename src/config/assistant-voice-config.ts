import { getEnv } from './env.js';

export const DEFAULT_VOICE_CONFIG = {
  enabled: false,
  apiKey: '',
  monthlyBudget: 5,
  usdPerMinute: 0.006,
  maxBytes: 1_048_576,
  maxSeconds: 120,
  dailyUser: 5,
  dailyChat: 10,
  timeoutMs: 60_000,
  ffmpegPath: '/usr/bin/ffmpeg',
};
export type AssistantVoiceConfig = typeof DEFAULT_VOICE_CONFIG;

export function loadVoiceConfig(): AssistantVoiceConfig {
  const number = (
    key: string,
    fallback: number,
    max: number,
    integer = true,
  ) => {
    const value = Number(getEnv(key) ?? fallback);
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > max ||
      (integer && (!Number.isInteger(value) || value < 1))
    )
      throw new Error(`Invalid ${key}`);
    return value;
  };
  const ffmpegPath =
    getEnv('VOICE_FFMPEG_PATH') || DEFAULT_VOICE_CONFIG.ffmpegPath;
  if (!ffmpegPath.startsWith('/')) throw new Error('Invalid VOICE_FFMPEG_PATH');
  const usdPerMinute = number('VOICE_USD_PER_MINUTE', 0.006, 1, false);
  if (usdPerMinute < 0.006) throw new Error('Invalid VOICE_USD_PER_MINUTE');
  return {
    ...DEFAULT_VOICE_CONFIG,
    enabled: getEnv('ENABLE_VOICE_MESSAGES') === 'true',
    // Dedicated credential only. Never silently reuse the chat-model key.
    apiKey: getEnv('TRANSCRIPTION_API_KEY')?.trim() || '',
    // Owner-approved maximum. Operators can lower it, never silently raise it.
    monthlyBudget: number('VOICE_MONTHLY_BUDGET_USD', 5, 5, false),
    usdPerMinute,
    maxSeconds: number('VOICE_MAX_SECONDS', 120, 120),
    dailyUser: number('VOICE_DAILY_PER_USER', 5, 20),
    dailyChat: number('VOICE_DAILY_PER_CHAT', 10, 60),
    timeoutMs: number('VOICE_TIMEOUT_MS', 60_000, 60_000),
    ffmpegPath,
  };
}
