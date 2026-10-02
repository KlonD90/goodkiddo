import { getEnv } from './env.js';

export const SPACE_BUNNY_METADATA = {
  windowTokens: 1_048_576,
  inputTokens: 524_288,
  source:
    'https://github.com/anomalyco/models.dev/blob/1af490fab48e51f098eb79d4cdf57802b04d251f/providers/opencode/models/space-bunny-free.toml',
};
export interface ContextConfig {
  /** Opt-in expanded text context using an explicitly approximate local BPE proxy. */
  textBudgetEnabled?: boolean;
  /** Runtime calibration loaded from persistence; never configured below the initial 1.25 margin. */
  estimateScale?: number;
  windowTokens: number;
  inputTokens: number;
  source: string;
  /** Verified upper bound for EACH supported image at detail=auto, not base64 size. */
  imageTokens?: number;
  imageSource?: string;
}

function verifiedInteger(
  key: string,
  setting: typeof getEnv,
): number | undefined {
  const raw = setting(key)?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`Invalid ${key}`);
  return value;
}

function metadataSource(
  key: string,
  setting: typeof getEnv,
): string | undefined {
  const value = setting(key)?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${key}`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    value.length > 2048
  )
    throw new Error(`Invalid ${key}`);
  return value;
}

export function loadContextConfig(
  baseUrl: string,
  model: string,
  setting = getEnv,
): ContextConfig {
  const enabled = setting('LLM_TEXT_CONTEXT_BUDGET_ENABLED');
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false')
    throw new Error('Invalid LLM_TEXT_CONTEXT_BUDGET_ENABLED');
  const known =
    [
      'https://opencode.ai/inference/openai/v1',
      'https://opencode.ai/zen/v1',
    ].includes(baseUrl) && model === 'space-bunny-free';
  const override = verifiedInteger('LLM_CONTEXT_WINDOW_TOKENS', setting);
  const source = metadataSource('LLM_CONTEXT_METADATA_SOURCE', setting);
  if (!!override !== !!source)
    throw new Error(
      'Invalid LLM_CONTEXT_WINDOW_TOKENS: requires LLM_CONTEXT_METADATA_SOURCE',
    );
  if (!known && !override && enabled === 'true')
    throw new Error(
      'Set LLM_CONTEXT_WINDOW_TOKENS and LLM_CONTEXT_METADATA_SOURCE for this model',
    );
  const windowTokens =
    override ?? (known ? SPACE_BUNNY_METADATA.windowTokens : 0);
  const inputTokens =
    verifiedInteger('LLM_MAX_INPUT_TOKENS', setting) ??
    (override ? windowTokens : known ? SPACE_BUNNY_METADATA.inputTokens : 0);
  if (inputTokens > windowTokens)
    throw new Error('Invalid LLM_MAX_INPUT_TOKENS');
  const imageTokens = verifiedInteger('LLM_IMAGE_TOKEN_UPPER_BOUND', setting);
  const imageSource = metadataSource(
    'LLM_IMAGE_TOKEN_METADATA_SOURCE',
    setting,
  );
  if (!!imageTokens !== !!imageSource)
    throw new Error(
      'Invalid LLM_IMAGE_TOKEN_UPPER_BOUND: requires LLM_IMAGE_TOKEN_METADATA_SOURCE',
    );
  return {
    textBudgetEnabled: enabled === 'true',
    windowTokens,
    inputTokens,
    source: source ?? (known ? SPACE_BUNNY_METADATA.source : ''),
    imageTokens,
    imageSource,
  };
}
