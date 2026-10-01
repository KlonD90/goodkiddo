import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AssistantStore } from '../src/persistence/assistant-store.ts';
import {
  AssistantVoiceStore,
  voiceBudgetMonth,
  voiceReservedCost,
} from '../src/persistence/assistant-voice-store.ts';
import { AssistantIngress } from '../src/assistant/ingress.ts';
import { AssistantAnalytics } from '../src/integrations/assistant-analytics.ts';
import {
  TelegramAssistantApi,
  type TelegramUpdate,
} from '../src/channels/telegram-assistant-api.ts';
import {
  OpenAiWhisperVoice,
  type VoiceProvider,
} from '../src/providers/assistant-voice.ts';
import { clearChatContext } from '../src/assistant/context.ts';
import { fileConfig } from './fixtures/file-assistant-config.ts';

const TEST_FFMPEG =
  process.env.VOICE_TEST_FFMPEG_PATH ||
  (process.platform === 'darwin'
    ? '/opt/homebrew/bin/ffmpeg'
    : '/usr/bin/ffmpeg');

function config() {
  const c = fileConfig();
  c.monthlyBudget = 30;
  c.voice = {
    ...c.voice,
    enabled: true,
    apiKey: 'synthetic-only',
    monthlyBudget: 5,
  };
  return c;
}
function update(
  id = 1,
  type: 'private' | 'supergroup' = 'private',
  user = 3,
  chat = type === 'private' ? 1 : -1,
): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      chat: { id: chat, type },
      from: { id: user, first_name: 'Synthetic' },
      voice: {
        file_id: 'synthetic',
        duration: 5,
        file_size: 40,
        mime_type: 'audio/ogg',
      },
      message_thread_id: 7,
      date: 1790849589,
    },
  };
}
function setup(provider?: VoiceProvider) {
  const c = config(),
    store = new AssistantStore(':memory:');
  let downloads = 0,
    transcriptions = 0;
  const api = {
    downloadDocument: async () => {
      downloads++;
      return new TextEncoder().encode('OggSsynthetic');
    },
    call: async () => ({ status: 'administrator' }),
  } as unknown as TelegramAssistantApi;
  const p: VoiceProvider = provider || {
    prepare: async () => ({ bytes: new Uint8Array(44), seconds: 5 }),
    transcribe: async () => {
      transcriptions++;
      return 'Напомни позвонить завтра';
    },
  };
  const analytics = new AssistantAnalytics(c, store);
  const ingress = new AssistantIngress(
    store,
    c,
    analytics,
    api,
    { id: 99, username: 'goodkiddo_bot' },
    p,
  );
  return {
    c,
    store,
    ingress,
    api,
    counts: () => ({ downloads, transcriptions }),
    receipt: (id = 1) => new AssistantVoiceStore(store).receipt(id),
    replies: () =>
      store.db.query('SELECT text FROM assistant_outbox').all() as {
        text: string;
      }[],
  };
}
function blocked(signal: AbortSignal): Promise<string> {
  return new Promise((_, reject) =>
    signal.addEventListener(
      'abort',
      () => reject(new Error('synthetic abort')),
      { once: true },
    ),
  );
}

test('voice reaches the normal inbox with original author/chat/topic/date and single accepted event', async () => {
  const s = setup();
  expect(await s.ingress.handle(update())).toBe('processing_voice');
  await s.ingress.voice.idle();
  const request = s.store.nextRequest()!;
  expect(request.actor.id).toBe('3');
  expect(request.chat.id).toBe('1');
  expect(request.messageThreadId).toBe(7);
  expect(request.userText).toBe('Напомни позвонить завтра');
  expect(request.messageAt).toBeTruthy();
  expect(request.inputType).toBe('voice');
  expect(s.receipt()?.status).toBe('completed');
  expect(s.receipt()?.cost_usd).toBe(0.006);
  expect(s.counts()).toEqual({ downloads: 1, transcriptions: 1 });
  expect(await s.ingress.handle(update())).toBe('duplicate_voice');
  expect(s.counts().transcriptions).toBe(1);
  await s.ingress.voice.stop();
  s.store.close();
});
test('unaddressed groups, bot senders, channels and forwarded voices never download', async () => {
  const s = setup();
  expect(await s.ingress.handle(update(1, 'supergroup'))).toBe(
    'ignored_unaddressed',
  );
  const bot = update(2);
  bot.message!.from!.is_bot = true;
  await s.ingress.handle(bot);
  const forward = update(3);
  forward.message!.forward_origin = { type: 'hidden_user', date: 1 };
  expect(await s.ingress.handle(forward)).toBe('rejected_forwarded_voice');
  const channel = update(4);
  channel.message!.chat.type = 'channel';
  await s.ingress.handle(channel);
  expect(s.counts().downloads).toBe(0);
  s.store.close();
});
test('a reply to this bot accepts group voice with the current author', async () => {
  const s = setup(),
    u = update(1, 'supergroup');
  u.message!.reply_to_message = { from: { id: 99 } };
  expect(await s.ingress.handle(u)).toBe('processing_voice');
  await s.ingress.voice.idle();
  expect(s.store.nextRequest()!.interaction).toBe('reply');
  expect(s.store.nextRequest()!.actor.id).toBe('3');
  s.store.close();
});
test('transcribed slash text and captions do not execute control commands', async () => {
  const s = setup({
    prepare: async () => ({ bytes: new Uint8Array(44), seconds: 1 }),
    transcribe: async () => '/clear',
  });
  const u = update();
  u.message!.caption = '/clear';
  await s.ingress.handle(u);
  await s.ingress.voice.idle();
  expect(s.store.contextVersion('1')).toBe(0);
  expect(s.store.nextRequest()!.userText).toContain('/clear');
  s.store.close();
});
test('feature/key/budget gates prevent downloads and paid calls', async () => {
  for (const gate of ['enabled', 'apiKey', 'monthlyBudget'] as const) {
    const s = setup();
    if (gate === 'enabled') s.c.voice.enabled = false;
    else if (gate === 'apiKey') s.c.voice.apiKey = '';
    else s.c.voice.monthlyBudget = 0;
    expect(await s.ingress.handle(update())).toBe('unsupported_voice');
    expect(s.counts().downloads).toBe(0);
    s.store.close();
  }
});
test('zero shared service budget blocks paid voice before download even with its approved voice cap', async () => {
  const s = setup();
  s.c.monthlyBudget = 0;
  try {
    expect(await s.ingress.handle(update())).toBe('limited_voice');
    expect(s.counts().downloads).toBe(0);
    expect(s.counts().transcriptions).toBe(0);
    expect(s.store.monthSpend()).toBe(0);
    expect(
      s.store.db
        .query('SELECT COUNT(*) AS n FROM assistant_voice_requests')
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    await s.ingress.voice.stop();
    s.store.close();
  }
});
test('metadata limits reject oversize, too long, zero and invalid durations/MIME before download', async () => {
  for (const voice of [
    { duration: 121 },
    { duration: 0 },
    { duration: NaN },
    { file_size: 1_048_577 },
    { mime_type: 'text/html' },
  ]) {
    const s = setup(),
      u = update();
    Object.assign(u.message!.voice!, voice);
    expect(await s.ingress.handle(u)).toBe('rejected_voice');
    expect(s.counts().downloads).toBe(0);
    s.store.close();
  }
});
test('daily persisted voice quotas prevent another call while text still queues', async () => {
  const s = setup();
  s.c.voice.dailyUser = 1;
  await s.ingress.handle(update());
  await s.ingress.voice.idle();
  expect(await s.ingress.handle(update(2))).toBe('limited_voice');
  const text = update(3);
  delete text.message!.voice;
  text.message!.text = 'Обычная задача';
  expect(await s.ingress.handle(text)).toBe('enqueued_message');
  expect(s.counts().transcriptions).toBe(1);
  s.store.close();
});
test('in-flight voice does not block commands and owner cancellation aborts without queuing a transcript', async () => {
  const s = setup({
    prepare: async () => ({ bytes: new Uint8Array(44), seconds: 5 }),
    transcribe: async (_, signal) => blocked(signal),
  });
  await s.ingress.handle(update());
  await new Promise((r) => setTimeout(r, 1));
  expect(await s.ingress.handle(update(2))).toBe('busy_voice');
  const cancel = update(3);
  delete cancel.message!.voice;
  cancel.message!.text = '/cancel_voice';
  expect(await s.ingress.handle(cancel)).toBe('command');
  await s.ingress.voice.idle();
  expect(s.store.nextRequest()).toBeUndefined();
  expect(s.receipt()?.status).toBe('cancelled');
  expect(s.receipt()?.cost_usd).toBe(0.012);
  s.store.close();
});
test('another owner or chat cannot cancel voice', async () => {
  const s = setup({
    prepare: async () => ({ bytes: new Uint8Array(44), seconds: 5 }),
    transcribe: async (_, signal) => blocked(signal),
  });
  await s.ingress.handle(update());
  expect(s.ingress.voice.cancel('1', '4')).toBe(0);
  expect(s.ingress.voice.cancel('-1', '3')).toBe(0);
  await s.ingress.voice.stop();
  s.store.close();
});
test('/clear cancels voice and suppresses stale transcript and voice failure reply', async () => {
  const s = setup({
    prepare: async () => ({ bytes: new Uint8Array(44), seconds: 5 }),
    transcribe: async (_, signal) => blocked(signal),
  });
  await s.ingress.handle(update());
  await new Promise((r) => setTimeout(r, 1));
  clearChatContext(s.store, '1');
  await s.ingress.voice.idle();
  expect(s.store.nextRequest()).toBeUndefined();
  expect(s.receipt()?.status).toBe('cancelled');
  expect(s.replies().some((r) => r.text.includes('недоступно'))).toBe(false);
  s.store.close();
});
test('timeout is bounded, keeps submitted reservation and emits a safe failure', async () => {
  const s = setup({
    prepare: async () => ({ bytes: new Uint8Array(44), seconds: 5 }),
    transcribe: async (_, signal) => blocked(signal),
  });
  s.c.voice.timeoutMs = 10;
  await s.ingress.handle(update());
  await s.ingress.voice.idle();
  expect(s.receipt()?.cost_usd).toBe(0.012);
  expect(s.store.nextRequest()).toBeUndefined();
  expect(s.replies().some((r) => r.text.includes('недоступно'))).toBe(true);
  s.store.close();
});
test('failed preparation refunds reservation and never calls transcription', async () => {
  let calls = 0;
  const s = setup({
    prepare: async () => {
      throw new Error('synthetic token-bearing URL');
    },
    transcribe: async () => {
      calls++;
      return 'x';
    },
  });
  await s.ingress.handle(update());
  await s.ingress.voice.idle();
  expect(calls).toBe(0);
  expect(s.receipt()?.cost_usd).toBe(0);
  expect(JSON.stringify(s.replies())).not.toContain('token-bearing');
  s.store.close();
});
test('unknown decoded duration or overlimit audio prevents paid call', async () => {
  for (const seconds of [NaN, 0, 121]) {
    let calls = 0;
    const s = setup({
      prepare: async () => ({ bytes: new Uint8Array(44), seconds }),
      transcribe: async () => {
        calls++;
        return 'x';
      },
    });
    await s.ingress.handle(update());
    await s.ingress.voice.idle();
    expect(calls).toBe(0);
    expect(s.receipt()?.cost_usd).toBe(0);
    s.store.close();
  }
});
test('provider upload failure keeps the reservation, remains deduplicated and cannot break text intake', async () => {
  const s = setup({
    prepare: async () => ({ bytes: new Uint8Array(44), seconds: 5 }),
    transcribe: async () => {
      throw new Error('synthetic key and audio text');
    },
  });
  await s.ingress.handle(update());
  await s.ingress.voice.idle();
  expect(s.receipt()?.cost_usd).toBe(0.012);
  expect(await s.ingress.handle(update())).toBe('duplicate_voice');
  expect(JSON.stringify(s.replies())).not.toContain('synthetic key');
  const u = update(2);
  delete u.message!.voice;
  u.message!.text = '/help';
  expect(await s.ingress.handle(u)).toBe('command');
  s.store.close();
});
test('global 5 USD limit is persisted and enforced across database connections', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'voice-budget-')),
    db = path.join(dir, 'test.db');
  const a = new AssistantStore(db),
    b = new AssistantStore(db),
    ca = new AssistantVoiceStore(a),
    cb = new AssistantVoiceStore(b),
    c = config();
  try {
    for (let i = 0; i < 416; i++)
      (i % 2 ? ca : cb).reserve(
        {
          update_id: i,
          chat_id: String(i),
          user_id: String(i),
          thread_id: null,
          context_version: 0,
        },
        c,
      );
    expect(a.monthSpend()).toBeCloseTo(4.992);
    expect(() =>
      cb.reserve(
        {
          update_id: 999,
          chat_id: 'x',
          user_id: 'x',
          thread_id: null,
          context_version: 0,
        },
        c,
      ),
    ).toThrow('расходов');
    expect(() =>
      ca.reserve(
        {
          update_id: 0,
          chat_id: '0',
          user_id: '0',
          thread_id: null,
          context_version: 0,
        },
        c,
      ),
    ).toThrow();
    expect(a.monthSpend()).toBeCloseTo(4.992);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('restart preserves ambiguous spend and never repeats transcription', async () => {
  const s = setup();
  const receipt = new AssistantVoiceStore(s.store);
  receipt.reserve(
    {
      update_id: 1,
      chat_id: '1',
      user_id: '3',
      thread_id: 7,
      context_version: 0,
    },
    s.c,
  );
  receipt.submit(1, s.c);
  const newIngress = new AssistantIngress(
    s.store,
    s.c,
    new AssistantAnalytics(s.c, s.store),
    s.api,
    { id: 99 },
  );
  expect(s.receipt()?.status).toBe('interrupted');
  expect(s.receipt()?.cost_usd).toBe(0.012);
  expect(await newIngress.handle(update())).toBe('duplicate_voice');
  expect(s.counts().transcriptions).toBe(0);
  s.store.close();
});
test('budget month uses Asia/Tbilisi boundary and decoded cost rounds conservatively', () => {
  expect(voiceBudgetMonth(new Date('2026-09-30T19:59:59Z'))).toBe('2026-09');
  expect(voiceBudgetMonth(new Date('2026-09-30T20:00:00Z'))).toBe('2026-10');
  expect(voiceReservedCost(60.01, 0.006)).toBe(0.012);
  expect(voiceReservedCost(0.5, 0.006)).toBe(0.006);
});
test('upload-time check cannot bypass new month cap with an old month reservation', () => {
  const s = setup(),
    receipts = new AssistantVoiceStore(s.store);
  receipts.reserve(
    {
      update_id: 1,
      chat_id: '1',
      user_id: '3',
      thread_id: null,
      context_version: 0,
    },
    s.c,
  );
  s.store.db
    .query(
      "UPDATE assistant_voice_requests SET budget_month='2000-01' WHERE update_id=1",
    )
    .run();
  receipts.reserve(
    {
      update_id: 2,
      chat_id: '2',
      user_id: '4',
      thread_id: null,
      context_version: 0,
    },
    s.c,
  );
  s.store.db
    .query('UPDATE assistant_voice_requests SET cost_usd=5 WHERE update_id=2')
    .run();
  expect(() => receipts.submit(1, s.c)).toThrow('расходов');
  s.store.close();
});
test('provider posts only WAV and whisper-1 to fixed OpenAI endpoint with no transcript context', async () => {
  const c = config();
  let calls = 0;
  const p = new OpenAiWhisperVoice(c.voice, (async (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    calls++;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init?.redirect).toBe('error');
    const form = init!.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('prompt')).toBeNull();
    expect((form.get('file') as File).name).toBe('voice.wav');
    return Response.json({ text: 'Тест' });
  }) as unknown as typeof fetch);
  expect(
    await p.transcribe(
      { bytes: new Uint8Array(44), seconds: 1 },
      new AbortController().signal,
    ),
  ).toBe('Тест');
  expect(calls).toBe(1);
});
test('provider rejects errors, empty/invalid/oversize results without leaking body', async () => {
  for (const response of [
    new Response('SECRET provider error', { status: 401 }),
    Response.json({ text: '' }),
    new Response('{'),
    Response.json({ text: 'x'.repeat(10001) }),
    new Response('x'.repeat(64001)),
  ]) {
    const p = new OpenAiWhisperVoice(
      config().voice,
      (async () => response) as unknown as typeof fetch,
    );
    await expect(
      p.transcribe(
        { bytes: new Uint8Array(44), seconds: 1 },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  }
});

test('voice analytics contains only safe input enum and pseudonyms, never transcript/audio', async () => {
  const c = config();
  c.posthogKey = 'synthetic-project';
  c.analyticsSalt = 'synthetic-salt';
  const store = new AssistantStore(':memory:');
  const analytics = new AssistantAnalytics(c, store, () => ({
    capture() {},
    async flush() {},
    async shutdown() {},
  }));
  const api = {
    downloadDocument: async () => new Uint8Array(4),
  } as unknown as TelegramAssistantApi;
  const ingress = new AssistantIngress(
    store,
    c,
    analytics,
    api,
    { id: 99 },
    {
      prepare: async () => ({ bytes: new Uint8Array(44), seconds: 1 }),
      transcribe: async () => 'PRIVATE TRANSCRIPT',
    },
  );
  await ingress.handle(update());
  await ingress.voice.idle();
  await ingress.handle(update());
  const events = store.db
    .query('SELECT payload FROM assistant_events')
    .all() as { payload: string }[];
  expect(events.length).toBe(2);
  expect(
    events.every(
      (e) => JSON.parse(e.payload).properties.input_type === 'voice',
    ),
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain('PRIVATE TRANSCRIPT');
  expect(JSON.stringify(events)).not.toContain('file_id');
  store.close();
});
test('Telegram voice file download is streamed/bounded and accepts cancellation without exposing token', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = (async (
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (String(url).includes('/getFile'))
        return Response.json({
          ok: true,
          result: { file_path: 'voice/test.ogg' },
        });
      expect(init?.signal).toBeDefined();
      return new Response(new Uint8Array(9), {
        headers: { 'Content-Length': '9' },
      });
    }) as unknown as typeof fetch;
    const api = new TelegramAssistantApi('synthetic-only');
    await expect(
      api.downloadDocument('synthetic', 8, new AbortController().signal),
    ).rejects.toThrow('размер');
    let called = 0;
    globalThis.fetch = (async (
      _: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      called++;
      init?.signal?.throwIfAborted();
      throw new Error('synthetic token URL');
    }) as unknown as typeof fetch;
    const stop = new AbortController();
    stop.abort();
    await expect(
      api.downloadDocument('synthetic', 8, stop.signal),
    ).rejects.toThrow('Telegram request failed');
    expect(called).toBe(1);
  } finally {
    globalThis.fetch = previous;
  }
});

// Generated tone only, no recorded user audio; the OpenAI HTTP call stays mocked.
async function syntheticOgg(seconds: number): Promise<Uint8Array> {
  const p = Bun.spawn(
    [
      TEST_FFMPEG,
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=16000',
      '-t',
      String(seconds),
      '-c:a',
      'libopus',
      '-f',
      'ogg',
      'pipe:1',
    ],
    { stdout: 'pipe', stderr: 'ignore', env: {} },
  );
  const bytes = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  expect(await p.exited).toBe(0);
  return bytes;
}
test('real local decoder emits bounded mono WAV and measures duration before mocked upload', async () => {
  const c = config();
  c.voice.ffmpegPath = TEST_FFMPEG;
  const p = new OpenAiWhisperVoice(c.voice, (async () =>
    Response.json({ text: 'Synthetic' })) as unknown as typeof fetch);
  const prepared = await p.prepare(
    await syntheticOgg(0.5),
    new AbortController().signal,
  );
  expect(prepared.seconds).toBeCloseTo(0.5, 1);
  expect(new TextDecoder().decode(prepared.bytes.subarray(0, 4))).toBe('RIFF');
  expect(new DataView(prepared.bytes.buffer).getUint32(24, true)).toBe(16000);
  expect(await p.transcribe(prepared, new AbortController().signal)).toBe(
    'Synthetic',
  );
});
test('actual decoded duration over cap and malformed Ogg are rejected before upload', async () => {
  const c = config();
  c.voice.ffmpegPath = TEST_FFMPEG;
  c.voice.maxSeconds = 1;
  const p = new OpenAiWhisperVoice(c.voice);
  await expect(
    p.prepare(await syntheticOgg(2.1), new AbortController().signal),
  ).rejects.toThrow('секунд');
  await expect(
    p.prepare(
      new TextEncoder().encode('OggSmalformed'),
      new AbortController().signal,
    ),
  ).rejects.toThrow('прочитать');
  await expect(
    p.prepare(new Uint8Array(1_048_577), new AbortController().signal),
  ).rejects.toThrow('1 МиБ');
});

test('regular task quota also blocks audio upload before any spend', async () => {
  const s = setup();
  s.c.dailyTasks = 1;
  s.store.startRun(
    'previous',
    { id: '1', type: 'private', timezone: 'UTC', active: 1 },
    '3',
    'other',
  );
  expect(await s.ingress.handle(update())).toBe('limited_voice');
  expect(s.counts().downloads).toBe(0);
  expect(s.store.monthSpend()).toBe(0);
  s.store.close();
});

test('configuration refuses to raise the approved cap or underestimate current Whisper rate', async () => {
  const { loadVoiceConfig } =
    await import('../src/config/assistant-voice-config.ts');
  const budget = process.env.VOICE_MONTHLY_BUDGET_USD,
    price = process.env.VOICE_USD_PER_MINUTE;
  try {
    process.env.VOICE_MONTHLY_BUDGET_USD = '5.01';
    expect(() => loadVoiceConfig()).toThrow('VOICE_MONTHLY_BUDGET_USD');
    process.env.VOICE_MONTHLY_BUDGET_USD = '5';
    process.env.VOICE_USD_PER_MINUTE = '0.005';
    expect(() => loadVoiceConfig()).toThrow('VOICE_USD_PER_MINUTE');
    process.env.VOICE_USD_PER_MINUTE = '0.006';
    expect(loadVoiceConfig().monthlyBudget).toBe(5);
  } finally {
    if (budget === undefined) delete process.env.VOICE_MONTHLY_BUDGET_USD;
    else process.env.VOICE_MONTHLY_BUDGET_USD = budget;
    if (price === undefined) delete process.env.VOICE_USD_PER_MINUTE;
    else process.env.VOICE_USD_PER_MINUTE = price;
  }
});
test('two global jobs block a third and shutdown aborts all without an upload', async () => {
  const s = setup({
    prepare: async (_, signal) => {
      await blocked(signal);
      throw new Error('unreachable');
    },
    transcribe: async () => {
      throw new Error('must not upload');
    },
  });
  expect(await s.ingress.handle(update(1, 'private', 3, 1))).toBe(
    'processing_voice',
  );
  expect(await s.ingress.handle(update(2, 'private', 4, 2))).toBe(
    'processing_voice',
  );
  expect(await s.ingress.handle(update(3, 'private', 5, 3))).toBe('busy_voice');
  await s.ingress.voice.stop();
  expect(s.receipt(1)?.cost_usd).toBe(0);
  expect(s.receipt(2)?.cost_usd).toBe(0);
  s.store.close();
});
