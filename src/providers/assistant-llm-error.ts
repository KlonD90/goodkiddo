export class LlmRequestError extends Error {
  constructor(
    readonly status: number,
    readonly contextOverflow = false,
  ) {
    // Provider error bodies can contain prompts/credentials. Never retain or print them.
    super(
      `LLM ${contextOverflow ? 'context overflow' : 'request failed'} (${status})`,
    );
  }
}

export function providerRequestError(
  status: number,
  body: unknown,
): LlmRequestError {
  const error = (
    body as { error?: { code?: unknown; message?: unknown } } | null
  )?.error;
  const code = error?.code;
  const message =
    typeof error?.message === 'string' ? error.message.slice(0, 16_384) : '';
  const excluded = /rate limit|too many requests|quota|throttl/i.test(message);
  const explicit =
    code === 'context_length_exceeded' ||
    code === 'model_context_window_exceeded';
  const overflow =
    /(?:maximum context length is [\d,]+ tokens|exceeds.*maximum context length|context[_ ]length[_ ]exceeded|exceeds (?:the )?(?:model'?s )?context window|input token count.*exceeds the maximum|input \([\d,]+ tokens\) is longer than the model'?s context length|prompt is too long.*tokens)/i.test(
      message,
    );
  return new LlmRequestError(
    status,
    [200, 400, 413, 422].includes(status) &&
      !excluded &&
      (explicit || overflow),
  );
}

export async function readRequestError(
  response: Response,
): Promise<LlmRequestError> {
  if (!response.body) return new LlmRequestError(response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 16_384) return new LlmRequestError(response.status);
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return providerRequestError(response.status, JSON.parse(text));
  } catch {
    return new LlmRequestError(response.status);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
