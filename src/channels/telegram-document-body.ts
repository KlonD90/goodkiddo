export class TelegramFileError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export async function boundedDocumentBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const advertised = Number(response.headers.get('Content-Length') || 0);
  if (advertised > maxBytes) {
    await response.body?.cancel();
    throw new TelegramFileError('Документ превышает допустимый размер.');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TelegramFileError('Документ превышает допустимый размер.');
      }
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } finally {
    reader.releaseLock();
  }
}
