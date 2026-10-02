import { createHash } from 'node:crypto';
import type { AssistantConfig } from '../config/assistant-config.js';
import type { AssistantStore } from './assistant-store.js';
import {
  INITIAL_ESTIMATE_SCALE,
  TOKEN_ESTIMATOR,
} from '../providers/assistant-token-estimate.js';

function key(config: AssistantConfig): string {
  const scope = createHash('sha256')
    .update(JSON.stringify([config.baseUrl, config.model, TOKEN_ESTIMATOR]))
    .digest('hex');
  return `context_estimate:${scope}`;
}

function savedScale(store: AssistantStore, config: AssistantConfig): number {
  try {
    const saved = JSON.parse(store.state(key(config)) ?? 'null');
    if (
      saved?.kind === TOKEN_ESTIMATOR &&
      Number.isFinite(saved.scale) &&
      saved.scale >= INITIAL_ESTIMATE_SCALE
    )
      return saved.scale;
  } catch {
    /* Missing/invalid calibration keeps the conservative initial margin. */
  }
  return INITIAL_ESTIMATE_SCALE;
}

export function contextEstimateConfig(
  store: AssistantStore,
  config: AssistantConfig,
): AssistantConfig {
  return {
    ...config,
    context: {
      ...config.context,
      estimateScale: Math.max(
        INITIAL_ESTIMATE_SCALE,
        config.context?.estimateScale ?? INITIAL_ESTIMATE_SCALE,
        savedScale(store, config),
      ),
    },
  };
}

// Calibrate only complete text requests; image tokens must not contaminate the text proxy.
// Cached input remains in prompt_tokens. Never infer a native tokenizer from usage.
export function observeTextUsage(
  store: AssistantStore,
  config: AssistantConfig,
  rawEstimate: number,
  promptTokens: number | undefined,
): void {
  if (
    !Number.isSafeInteger(promptTokens) ||
    promptTokens! <= 0 ||
    !Number.isSafeInteger(rawEstimate) ||
    rawEstimate <= 0
  )
    return;
  store.transaction(() => {
    const scale = Math.max(
      contextEstimateConfig(store, config).context.estimateScale!,
      (1.1 * promptTokens!) / rawEstimate,
    );
    store.setState(
      key(config),
      JSON.stringify({ kind: TOKEN_ESTIMATOR, scale }),
    );
  });
}
