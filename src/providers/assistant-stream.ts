import type { LlmMessage, ToolCall } from '../shared/assistant-types.js';
import type { Completion } from './assistant-llm.js';

export type ContentSnapshot = (text: string) => void;
interface StreamDelta {
  content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }[];
}
export async function readCompletionStream(
  response: Response,
  signal: AbortSignal,
  onContent: ContentSnapshot,
): Promise<Completion> {
  if (!response.body) throw new Error('Missing completion stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let size = 0;
  let done = false;
  let finished = false;
  let usage: Completion['usage'];
  const calls = new Map<number, ToolCall>();
  const event = (source: string) => {
    const data = source
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    if (data === '[DONE]') {
      done = true;
      return;
    }
    const payload = JSON.parse(data) as {
      error?: unknown;
      usage?: Completion['usage'];
      choices?: {
        index?: number;
        delta?: StreamDelta;
        finish_reason?: string | null;
      }[];
    };
    if (payload.error) throw new Error('Provider stream error');
    if (payload.usage) usage = payload.usage;
    const choice = payload.choices?.find((item) => (item.index || 0) === 0);
    if (!choice) return;
    if (choice.finish_reason) finished = true;
    const delta = choice.delta;
    // reasoning_content and other hidden fields never enter the visible message or callback.
    if (typeof delta?.content === 'string') {
      content += delta.content;
      if (content.length > 128_000)
        throw new Error('Completion content exceeds limit');
      onContent(content);
    }
    for (const fragment of delta?.tool_calls || []) {
      if (
        !Number.isInteger(fragment.index) ||
        fragment.index < 0 ||
        fragment.index >= 8
      )
        throw new Error('Too many tool calls');
      const call = calls.get(fragment.index) || {
        id: '',
        type: 'function' as const,
        function: { name: '', arguments: '' },
      };
      if (fragment.id) call.id += fragment.id;
      if (fragment.function?.name) call.function.name += fragment.function.name;
      if (fragment.function?.arguments)
        call.function.arguments += fragment.function.arguments;
      if (
        call.function.arguments.length > 65_536 ||
        call.function.name.length > 100 ||
        call.id.length > 200
      )
        throw new Error('Tool call exceeds limit');
      calls.set(fragment.index, call);
    }
  };
  try {
    while (!done) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      size += chunk.value.length;
      if (size > 4 * 1024 * 1024)
        throw new Error('Completion stream exceeds limit');
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        event(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
      if (buffer.length > 256_000)
        throw new Error('Completion event exceeds limit');
    }
    if (buffer.trim()) event(buffer);
    if (!done || !finished) throw new Error('Incomplete completion stream');
    const tool_calls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);
    if (tool_calls.some((call) => !call.id || !call.function.name))
      throw new Error('Incomplete tool call');
    if (!content && !tool_calls.length) throw new Error('Empty completion');
    const message: LlmMessage = {
      role: 'assistant',
      content: content || null,
      ...(tool_calls.length ? { tool_calls } : {}),
    };
    return { message, usage };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
