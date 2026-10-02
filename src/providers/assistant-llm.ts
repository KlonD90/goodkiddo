import type { AssistantConfig } from '../config/assistant-config.js';
import type { LlmMessage } from '../shared/assistant-types.js';
import {
  readCompletionStream,
  type ContentSnapshot,
} from './assistant-stream.js';
import { withImages, type ImageInput } from './assistant-vision.js';
import { completionInputEstimate } from './assistant-context-policy.js';
import {
  LlmRequestError,
  providerRequestError,
  readRequestError,
} from './assistant-llm-error.js';
export { LlmRequestError } from './assistant-llm-error.js';

export interface LlmTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
export interface Completion {
  message: LlmMessage;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}
export interface AssistantLlm {
  complete(
    messages: LlmMessage[],
    tools: LlmTool[],
    signal: AbortSignal,
    onContent?: ContentSnapshot,
    images?: ImageInput[],
  ): Promise<Completion>;
}
export class CompatibleAssistantLlm implements AssistantLlm {
  constructor(private readonly config: AssistantConfig) {}
  async complete(
    messages: LlmMessage[],
    tools: LlmTool[],
    signal: AbortSignal,
    onContent?: ContentSnapshot,
    images?: ImageInput[],
  ): Promise<Completion> {
    completionInputEstimate(messages, tools, this.config, images);
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...(this.config.apiKey
          ? { Authorization: `Bearer ${this.config.apiKey}` }
          : {}),
        'Content-Type': 'application/json',
        'User-Agent': `goodkiddo/${this.config.botVersion}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: withImages(messages, images),
        tools,
        tool_choice: 'auto',
        max_tokens: this.config.maxOutputTokens,
        stream: !!onContent,
        ...(onContent ? { stream_options: { include_usage: true } } : {}),
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
    });
    if (!response.ok) throw await readRequestError(response);
    if (onContent) return readCompletionStream(response, signal, onContent);
    const data = (await response.json()) as {
      choices?: { message: LlmMessage }[];
      usage?: Completion['usage'];
      error?: unknown;
    };
    if (data.error) throw providerRequestError(200, data);
    const message = data.choices?.[0]?.message;
    if (!message || (!message.content && !message.tool_calls?.length))
      throw new LlmRequestError(502);
    return {
      message: {
        content: typeof message.content === 'string' ? message.content : null,
        tool_calls: message.tool_calls,
        role: 'assistant',
      },
      usage: data.usage,
    };
  }
}
