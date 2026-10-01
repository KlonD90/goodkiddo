import type { AssistantVoiceConfig } from '../config/assistant-voice-config.js';

export class VoiceError extends Error {}
export interface PreparedVoice {
  bytes: Uint8Array;
  seconds: number;
}
export interface VoiceProvider {
  prepare(bytes: Uint8Array, signal: AbortSignal): Promise<PreparedVoice>;
  transcribe(audio: PreparedVoice, signal: AbortSignal): Promise<string>;
}

async function boundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!body) throw new VoiceError('Распознавание вернуло пустой ответ.');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new VoiceError('Превышен лимит обработки голосового.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function wav(pcm: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length);
  const header = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  header.setUint32(4, 36 + pcm.length, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, 16000, true);
  header.setUint32(28, 32000, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  header.setUint32(40, pcm.length, true);
  bytes.set(pcm, 44);
  return bytes;
}

export class OpenAiWhisperVoice implements VoiceProvider {
  constructor(
    private readonly config: AssistantVoiceConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async prepare(
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<PreparedVoice> {
    signal.throwIfAborted();
    if (
      !bytes.length ||
      bytes.length > this.config.maxBytes ||
      new TextDecoder().decode(bytes.subarray(0, 4)) !== 'OggS'
    )
      throw new VoiceError('Нужно голосовое Telegram в формате Ogg, до 1 МиБ.');
    // Decode only one bounded audio stream. No shell, paths, network protocols, inherited credentials or temporary files.
    const process = Bun.spawn(
      [
        this.config.ffmpegPath,
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-max_alloc',
        '16777216',
        '-threads',
        '1',
        '-protocol_whitelist',
        'pipe',
        '-f',
        'ogg',
        '-i',
        'pipe:0',
        '-t',
        String(this.config.maxSeconds + 1),
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-acodec',
        'pcm_s16le',
        '-f',
        's16le',
        'pipe:1',
      ],
      { stdin: bytes, stdout: 'pipe', stderr: 'ignore', env: {} },
    );
    const abort = () => process.kill('SIGKILL');
    const timeout = setTimeout(abort, 10_000);
    signal.addEventListener('abort', abort, { once: true });
    try {
      const pcm = await boundedBody(
        process.stdout,
        (this.config.maxSeconds + 1) * 32000,
      );
      if ((await process.exited) !== 0)
        throw new VoiceError('Не удалось прочитать голосовое. Пришлите текст.');
      signal.throwIfAborted();
      const seconds = pcm.length / 32000;
      if (seconds <= 0 || seconds > this.config.maxSeconds || pcm.length % 2)
        throw new VoiceError(
          `Голосовое должно быть не длиннее ${this.config.maxSeconds} секунд.`,
        );
      return { bytes: wav(pcm), seconds };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      abort();
      await process.exited;
    }
  }
  async transcribe(audio: PreparedVoice, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const body = new FormData();
    body.set('model', 'whisper-1');
    body.set('response_format', 'json');
    body.set(
      'file',
      new File([Uint8Array.from(audio.bytes)], 'voice.wav', {
        type: 'audio/wav',
      }),
    );
    try {
      const response = await this.fetcher(
        'https://api.openai.com/v1/audio/transcriptions',
        {
          method: 'POST',
          body,
          redirect: 'error',
          headers: { Authorization: `Bearer ${this.config.apiKey}` },
          signal,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new VoiceError(
          'Распознавание сейчас недоступно. Пришлите текст или повторите позже.',
        );
      }
      const data = JSON.parse(
        new TextDecoder().decode(await boundedBody(response.body, 64_000)),
      ) as { text?: unknown };
      if (
        typeof data.text !== 'string' ||
        !data.text.trim() ||
        data.text.length > 10_000
      )
        throw new VoiceError('Не удалось распознать речь. Пришлите текст.');
      signal.throwIfAborted();
      return data.text.trim();
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      // Provider responses and errors can include credentials/audio/text; never surface them.
      throw new VoiceError(
        'Распознавание прервано или недоступно. Пришлите текст.',
      );
    }
  }
}
