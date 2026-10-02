import { test, expect } from 'bun:test';
import { AssistantStore } from '../src/persistence/assistant-store.ts';
import { AssistantFiles } from '../src/persistence/assistant-files.ts';
import { AssistantAnalytics } from '../src/integrations/assistant-analytics.ts';
import {
  TelegramAssistantApi,
  TelegramApiError,
} from '../src/channels/telegram-assistant-api.ts';
import { CompatibleAssistantLlm } from '../src/providers/assistant-llm.ts';
import { AssistantIngress } from '../src/assistant/ingress.ts';
import { AssistantWorker } from '../src/assistant/worker.ts';
import {
  executeTool,
  toolDefinitions,
  type ToolContext,
} from '../src/assistant/tools.ts';
import { deliverMessages } from '../src/assistant/delivery.ts';
import { enqueueReply } from '../src/assistant/messages.ts';
import {
  textTarget,
  ensureTextDeliverySchema,
} from '../src/persistence/assistant-text-outbox.ts';
import { fileConfig } from './fixtures/file-assistant-config.ts';
import type { InboundRequest } from '../src/shared/assistant-types.ts';

function setup(type: 'private' | 'supergroup' = 'private') {
  const config = {
    ...fileConfig(),
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    model: 'space-bunny-free',
  };
  const store = new AssistantStore(':memory:');
  const chat = {
    id: type === 'private' ? '1' : '-2',
    type,
    timezone: 'UTC',
    active: 1,
  };
  store.saveChat(chat);
  const analytics = new AssistantAnalytics(config, store);
  const api = new TelegramAssistantApi('synthetic');
  const llm = new CompatibleAssistantLlm(config);
  const worker = new AssistantWorker(config, store, analytics, llm, api);
  const request: InboundRequest = {
    updateId: 50,
    chat,
    actor: { id: '3', name: 'Synthetic' },
    text: 'Compare options',
    interaction: 'message',
    messageThreadId: 7,
  };
  const files = new AssistantFiles(store.db, config.fileLimits);
  const ingress = new AssistantIngress(store, config, analytics, api, {
    id: 99,
    username: 'goodkiddo_bot',
  });
  return {
    config,
    store,
    chat,
    analytics,
    api,
    llm,
    worker,
    request,
    files,
    ingress,
  };
}
async function runWorker(s: ReturnType<typeof setup>) {
  s.store.enqueue(s.request);
  s.worker.wake();
  for (let i = 0; i < 1200; i++) {
    const row = s.store.db
      .query('SELECT status FROM assistant_inbox WHERE id=?')
      .get(s.request.updateId) as { status: string } | null;
    if (row?.status === 'done') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Synthetic worker did not finish');
}
function sse(slow = false): Response {
  const encoder = new TextEncoder();
  const events = [
    {
      choices: [{ index: 0, delta: { reasoning_content: 'SECRET reasoning' } }],
    },
    { choices: [{ index: 0, delta: { content: '**Answer**\n\n' } }] },
    {
      choices: [
        {
          index: 0,
          delta: { content: '| A | B |\n|---|---|\n| 1 | 2 |' },
          finish_reason: 'stop',
        },
      ],
    },
    {
      choices: [],
      usage: { prompt_tokens: 8, completion_tokens: 12, cost: 0 },
    },
  ];
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const [i, event] of events.entries()) {
          if (slow && i === 2)
            await new Promise((resolve) => setTimeout(resolve, 3400));
          controller.enqueue(
            encoder.encode('data: ' + JSON.stringify(event) + '\n\n'),
          );
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
test('actual provider -> worker -> private draft -> held durable rich final, including usage', async () => {
  const s = setup();
  const original = globalThis.fetch;
  const telegram: { method: string; body: any }[] = [];
  let modelBody: any;
  try {
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      if (String(url).includes('opencode.ai')) {
        modelBody = body;
        return sse();
      }
      const method = String(url).split('/').at(-1)!;
      telegram.push({ method, body });
      if (method === 'sendRichMessageDraft')
        expect(
          s.store.db
            .query(
              "SELECT COUNT(*) n FROM assistant_state WHERE key LIKE 'delivery_hold:%'",
            )
            .get(),
        ).toEqual({ n: 1 });
      return Response.json({ ok: true, result: { message_id: 321 } });
    }) as typeof fetch;
    await runWorker(s);
    expect(modelBody.stream).toBe(true);
    expect(modelBody.stream_options.include_usage).toBe(true);
    expect(
      telegram.some(
        (call) =>
          call.method === 'sendRichMessageDraft' &&
          call.body.message_thread_id === 7 &&
          call.body.draft_id === 50,
      ),
    ).toBe(true);
    expect(telegram.some((call) => call.method === 'sendRichMessage')).toBe(
      false,
    );
    expect(JSON.stringify(telegram)).not.toContain('SECRET');
    await deliverMessages(s.store, s.api, s.analytics);
    expect(
      telegram.filter((call) => call.method === 'sendRichMessage').length,
    ).toBe(1);
    expect(telegram.at(-1)?.body.rich_message.markdown).toContain('| A | B |');
    expect(telegram.at(-1)?.body.message_thread_id).toBe(7);
    const run = s.store.db
      .query('SELECT llm_calls,tokens_in,tokens_out,status FROM assistant_runs')
      .get();
    expect(run).toEqual({
      llm_calls: 1,
      tokens_in: 8,
      tokens_out: 12,
      status: 'success',
    });
  } finally {
    globalThis.fetch = original;
    await s.worker.stop();
    s.store.close();
  }
});
test('group streams edits then finalizes the same persisted message without a second send', async () => {
  const s = setup('supergroup');
  const original = globalThis.fetch;
  const calls: { method: string; body: any }[] = [];
  try {
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      if (String(url).includes('opencode.ai')) return sse(true);
      const method = String(url).split('/').at(-1)!;
      calls.push({ method, body: JSON.parse(String(init?.body || '{}')) });
      return Response.json({ ok: true, result: { message_id: 321 } });
    }) as typeof fetch;
    await runWorker(s);
    expect(
      calls.filter((call) => call.method === 'sendRichMessage').length,
    ).toBe(1);
    expect(
      calls.find((call) => call.method === 'sendRichMessage')?.body.rich_message
        .markdown,
    ).toBe('Готовлю ответ…');
    expect(calls.some((call) => call.method === 'editMessageText')).toBe(true);
    await deliverMessages(s.store, s.api, s.analytics);
    expect(
      calls.filter((call) => call.method === 'sendRichMessage').length,
    ).toBe(1);
    expect(
      calls.filter((call) => call.method === 'editMessageText').at(-1)?.body,
    ).toMatchObject({
      chat_id: '-2',
      message_id: 321,
      rich_message: {
        markdown: '**Answer**\n\n| A | B |\n|---|---|\n| 1 | 2 |',
      },
    });
    expect(calls.some((call) => call.method === 'sendRichMessageDraft')).toBe(
      false,
    );
    expect(JSON.stringify(calls)).not.toContain('SECRET');
  } finally {
    globalThis.fetch = original;
    await s.worker.stop();
    s.store.close();
  }
});
test('photo pipeline without image-token metadata stays working with the expanded-text flag enabled', async () => {
  const s = setup();
  const original = globalThis.fetch;
  const downloads: string[] = [];
  let modelBody: any;
  const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 0]);
  expect(s.config.context.textBudgetEnabled).toBe(true);
  expect(s.config.context.imageTokens).toBeUndefined();
  s.api.downloadDocument = async (id) => {
    downloads.push(id);
    return jpeg;
  };
  const base = {
    message_id: 2,
    from: { id: 3, first_name: 'Synthetic' },
    chat: { id: 1, type: 'private' as const },
    photo: [
      { file_id: 'small', width: 10, height: 10 },
      { file_id: 'large', width: 512, height: 512 },
    ],
  };
  try {
    expect(
      await s.ingress.handle({
        update_id: 51,
        message: { ...base, chat: { id: -2, type: 'supergroup' } },
      }),
    ).toBe('ignored_unaddressed');
    expect(downloads.length).toBe(0);
    expect(
      await s.ingress.handle({
        update_id: 52,
        message: {
          ...base,
          caption: '/clear',
          forward_origin: { type: 'user', date: 1000 },
        },
      }),
    ).toBe('stored_photo');
    expect(s.store.nextRequest()).toBeUndefined();
    expect(
      await s.ingress.handle({
        update_id: 50,
        message: { ...base, message_thread_id: 7 },
      }),
    ).toBe('enqueued_message');
    s.request = s.store.nextRequest()!;
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      if (String(url).includes('opencode.ai')) {
        modelBody = JSON.parse(String(init?.body));
        return sse();
      }
      return Response.json({ ok: true, result: { message_id: 321 } });
    }) as typeof fetch;
    await runWorker(s);
    expect(downloads).toEqual(['large', 'large']);
    const user = modelBody.messages
      .filter((message: any) => message.role === 'user')
      .at(-1);
    expect(user.content[1].image_url.url).toBe(
      'data:image/jpeg;base64,' + Buffer.from(jpeg).toString('base64'),
    );
    expect(JSON.stringify(s.store.history('1'))).not.toContain('base64');
    expect(() => s.files.get('-2', s.request.imagePaths![0])).toThrow();
    expect(
      s.store.db.query('SELECT llm_calls FROM assistant_runs').get(),
    ).toEqual({ llm_calls: 1 });
  } finally {
    globalThis.fetch = original;
    await s.worker.stop();
    s.store.close();
  }
});
test('describe_image without image-token metadata preserves file dispatch and model-call cap', async () => {
  const s = setup();
  s.analytics.start('test', s.chat, '3', 'other', 'user');
  const ctx: ToolContext = {
    ...s,
    taskId: 'test',
    request: s.request,
    signal: new AbortController().signal,
    searches: 0,
  };
  try {
    const names = toolDefinitions(false).map((tool) => tool.function.name);
    for (const name of [
      'write_file',
      'send_file',
      'read_url',
      'extract_file',
      'describe_image',
    ])
      expect(names).toContain(name);
    await executeTool(
      'write_file',
      JSON.stringify({
        file_path: '/report.csv',
        content: 'name,value\nAda,42',
      }),
      ctx,
    );
    const extracted = (await executeTool(
      'extract_file',
      JSON.stringify({ file_path: '/report.csv' }),
      ctx,
    )) as { text: string };
    expect(extracted.text).toContain('Ada');
    await expect(
      executeTool(
        'extract_file',
        JSON.stringify({ file_path: '/etc/passwd' }),
        ctx,
      ),
    ).rejects.toThrow('Файл не найден');
    s.files.write(
      '1',
      '/image.jpg',
      Uint8Array.from([255, 216, 255]),
      'image/jpeg',
    );
    ctx.llm = {
      complete: async () => ({
        message: { role: 'assistant', content: 'Synthetic image' },
        usage: { prompt_tokens: 3, completion_tokens: 4, cost: 0 },
      }),
    };
    expect(
      await executeTool(
        'describe_image',
        JSON.stringify({ file_path: '/image.jpg', question: 'Describe' }),
        ctx,
      ),
    ).toMatchObject({ text: 'Synthetic image' });
    expect(
      s.store.db
        .query(
          'SELECT llm_calls,tokens_in,tokens_out FROM assistant_runs WHERE id=?',
        )
        .get('test'),
    ).toEqual({ llm_calls: 1, tokens_in: 3, tokens_out: 4 });
    s.config.maxCalls = 1;
    await expect(
      executeTool(
        'describe_image',
        JSON.stringify({ file_path: '/image.jpg', question: 'Describe again' }),
        ctx,
      ),
    ).rejects.toThrow('лимит обращений');
  } finally {
    await s.worker.stop();
    s.store.close();
  }
});
test('uncertain final new send is never automatically resent, and receipt survives restart state', async () => {
  const s = setup();
  let sends = 0;
  s.api.send = async () => {
    sends++;
    throw new TelegramApiError(0);
  };
  try {
    const id = enqueueReply(s.store, 'uncertain', '1', 'Final')[0];
    await deliverMessages(s.store, s.api, s.analytics);
    await deliverMessages(s.store, s.api, s.analytics);
    expect(sends).toBe(1);
    expect(
      s.store.db
        .query('SELECT status FROM assistant_text_deliveries WHERE id=?')
        .get(id),
    ).toEqual({ status: 'uncertain' });
    s.store.send('crash', '1', 'Final');
    textTarget(s.store, 'crash', '1');
    s.store.db
      .query(
        "UPDATE assistant_text_deliveries SET status='sending' WHERE id='crash'",
      )
      .run();
    await deliverMessages(s.store, s.api, s.analytics);
    expect(sends).toBe(1);
  } finally {
    await s.worker.stop();
    s.store.close();
  }
});
test('final edit retry is idempotent and already-applied final is acknowledged', async () => {
  const s = setup('supergroup');
  let edits = 0;
  try {
    const id = enqueueReply(s.store, 'edit', '-2', 'Final', {
      messageId: 321,
    })[0];
    s.api.editRich = async () => {
      edits++;
      if (edits === 1) throw new TelegramApiError(0);
    };
    await deliverMessages(s.store, s.api, s.analytics);
    expect(
      s.store.db
        .query('SELECT status FROM assistant_text_deliveries WHERE id=?')
        .get(id),
    ).toEqual({ status: 'pending' });
    s.store.db
      .query("UPDATE assistant_outbox SET next_attempt='2000-01-01'")
      .run();
    await deliverMessages(s.store, s.api, s.analytics);
    expect(edits).toBe(2);
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async (_url: string | URL | Request) =>
        Response.json({
          ok: false,
          error_code: 400,
          description: 'Bad Request: message is not modified',
        })) as typeof fetch;
      await new TelegramAssistantApi('synthetic').editRich('-2', 321, 'Final');
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    await s.worker.stop();
    s.store.close();
  }
});
test('interrupted group run reuses durable preview for its recovery reply', async () => {
  const s = setup('supergroup');
  const edits: number[] = [];
  try {
    ensureTextDeliverySchema(s.store);
    s.analytics.start('interrupted', s.chat, '3', 'other', 'user');
    s.store.setState('delivery_hold:interrupted', '1');
    s.store.db
      .query(
        "INSERT INTO assistant_reply_previews(run_id,chat_id,message_id,status) VALUES ('interrupted','-2',321,'active')",
      )
      .run();
    s.api.editRich = async (_chat, id) => {
      edits.push(id);
    };
    s.api.send = async () => {
      throw new Error('Recovery must edit');
    };
    s.worker.recoverInterrupted();
    await deliverMessages(s.store, s.api, s.analytics);
    expect(edits).toEqual([321]);
    expect(s.store.state('delivery_hold:interrupted')).toBeUndefined();
  } finally {
    await s.worker.stop();
    s.store.close();
  }
});
