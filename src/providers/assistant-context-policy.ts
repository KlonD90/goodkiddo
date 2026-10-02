import type { AssistantConfig } from '../config/assistant-config.js';
import type { LlmMessage } from '../shared/assistant-types.js';
import type { LlmTool } from './assistant-llm.js';
import {
  assertRequestFits,
  selectHistory,
} from './assistant-context-budget.js';
import type { ImageInput } from './assistant-vision.js';

export function strictContextEnabled(
  config: AssistantConfig,
  images: ImageInput[] = [],
): boolean {
  return (
    config.context.textBudgetEnabled === true &&
    (!images.length ||
      !!(config.context.imageTokens && config.context.imageSource))
  );
}

// This is the pre-checkpoint FINANCIAL reservation heuristic. Base64 bytes are
// NOT model image tokens and this compatibility path makes no vision-window guarantee.
export function completionInputEstimate(
  messages: LlmMessage[],
  tools: LlmTool[],
  config: AssistantConfig,
  images: ImageInput[] = [],
): number {
  if (strictContextEnabled(config, images))
    return assertRequestFits(messages, tools, config, images);
  return financialInputAllowance(messages, tools, images);
}

// Preserve the baseline conservative FINANCIAL reservation separately from BPE context units.
export function financialInputAllowance(
  messages: LlmMessage[],
  tools: LlmTool[],
  images: ImageInput[] = [],
): number {
  return (
    Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') +
    1024 +
    images.reduce(
      (total, image) => total + Math.ceil((image.bytes.length * 4) / 3) + 256,
      0,
    )
  );
}

export function conversationMessages(
  args: Parameters<typeof selectHistory>[0],
): LlmMessage[] {
  if (strictContextEnabled(args.config, args.images))
    return selectHistory(args);
  // The off flag and unverified vision retain the baseline input view. Full
  // persisted sources/idle semantic compaction are independent of this legacy view.
  const bounded = (message: LlmMessage): LlmMessage =>
    message.role === 'tool'
      ? message
      : { ...message, content: message.content?.slice(0, 12000) ?? null };
  return [
    args.system,
    ...args.history.slice(-23).map(bounded),
    ...args.current.map(bounded),
  ];
}
