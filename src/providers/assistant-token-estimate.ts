import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
import type { AssistantConfig } from '../config/assistant-config.js';

// A pinned, local BPE proxy. Space Bunny's native tokenizer is unpublished.
export const TOKEN_ESTIMATOR = 'o200k_base_proxy_128_v1';
export const INITIAL_ESTIMATE_SCALE = 1.25;
const tokenizer = new Tiktoken(o200kBase);

export function textTokens(text: string): number {
  // User/source text may contain token-looking strings; count them as ordinary data.
  // Bound JS BPE work on giant single words. Windows affect counting only: the
  // model and archive still receive the original, complete text. Boundary overhead
  // is conservative and included in this explicitly approximate estimator version.
  let count = 0;
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + 128, text.length);
    const before = text.charCodeAt(end - 1);
    const after = text.charCodeAt(end);
    if (
      before >= 0xd800 &&
      before <= 0xdbff &&
      after >= 0xdc00 &&
      after <= 0xdfff
    )
      end--;
    count += tokenizer.encode(text.slice(start, end), [], []).length;
    start = end;
  }
  return count;
}

export function estimateScale(config: AssistantConfig): number {
  const scale = config.context?.estimateScale ?? INITIAL_ESTIMATE_SCALE;
  if (!Number.isFinite(scale) || scale < INITIAL_ESTIMATE_SCALE)
    throw new Error('Invalid context estimate scale');
  return scale;
}
