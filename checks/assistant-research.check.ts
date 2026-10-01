import { test, expect } from 'bun:test';
import { AssistantStore } from '../src/persistence/assistant-store.ts';
import { AssistantFiles } from '../src/persistence/assistant-files.ts';
import { AssistantAnalytics } from '../src/integrations/assistant-analytics.ts';
import {
  executeResearchTool,
  researchToolDefinitions,
} from '../src/assistant/research-tools.ts';
import { BudgetExceeded } from '../src/assistant/budget.ts';
import { runAssistant } from '../src/assistant/agent.ts';
import { executeTool, toolDefinitions } from '../src/assistant/tools.ts';
import {
  ReadOnlyBrowserJob,
  BrowserSlots,
} from '../src/capabilities/browser/job.ts';
import { BrowserNetworkPolicy } from '../src/capabilities/browser/network-policy.ts';
import { fileConfig } from './fixtures/file-assistant-config.ts';
import type { ToolContext } from '../src/assistant/tools.ts';
import type { LlmMessage } from '../src/shared/assistant-types.ts';

function setup() {
  const config = fileConfig();
  const store = new AssistantStore(':memory:');
  const chat = {
    id: 'chat-a',
    type: 'private' as const,
    timezone: 'UTC',
    active: 1,
  };
  store.saveChat(chat);
  const request = {
    updateId: 1,
    chat,
    actor: { id: 'actor', name: 'Synthetic' },
    text: 'Research supplied sources',
    interaction: 'message' as const,
  };
  store.startRun('task-a', chat, 'actor', 'other');
  const files = new AssistantFiles(store.db, config.fileLimits);
  files.write(
    'chat-a',
    '/source.txt',
    new TextEncoder().encode('Synthetic source A'),
  );
  files.write(
    'chat-b',
    '/secret.txt',
    new TextEncoder().encode('SECRET_OTHER_CHAT'),
  );
  store.remember('chat-a', 'user', 'PARENT_HISTORY_NOT_IN_SUBAGENT');
  let calls = 0;
  const received: LlmMessage[][] = [];
  const responses: LlmMessage[] = [];
  const ctx: ToolContext = {
    store,
    config,
    request,
    taskId: 'task-a',
    searches: 0,
    signal: new AbortController().signal,
    analytics: new AssistantAnalytics(config, store),
    llm: {
      complete: async (messages, tools) => {
        calls++;
        received.push(structuredClone(messages));
        expect(
          tools.some((tool) =>
            ['write_file', 'send_file', 'research', 'create_reminder'].includes(
              tool.function.name,
            ),
          ),
        ).toBe(false);
        return {
          message: responses.shift() || {
            role: 'assistant',
            content: 'Synthetic summary',
          },
          usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 },
        };
      },
    },
  };
  return { ctx, store, files, responses, received, calls: () => calls };
}
function call(name: string, args: unknown): LlmMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: name,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

test('same-model subagent uses shared meter, isolates context and stores same-chat notes', async () => {
  const s = setup();
  try {
    s.store.addUsage('task-a', {
      llm_calls: 1,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    });
    s.responses.push(
      call('read_file', { file_path: '/source.txt' }),
      call('record_finding', {
        source: '/source.txt',
        summary: 'Source A finding',
      }),
      { role: 'assistant', content: 'Source A synthesis' },
    );
    const result = await executeResearchTool(
      { question: 'Read source A', inputs: ['/source.txt'] },
      s.ctx,
    );
    expect(result.summary).toBe('Source A synthesis');
    expect(s.calls()).toBe(3);
    expect(s.store.runUsage('task-a').llm_calls).toBe(4);
    expect(JSON.stringify(s.received)).not.toContain(
      'PARENT_HISTORY_NOT_IN_SUBAGENT',
    );
    expect(JSON.stringify(s.received)).not.toContain('SECRET_OTHER_CHAT');
    expect(
      JSON.parse(
        new TextDecoder().decode(
          s.files.get('chat-a', result.notes_path).content,
        ),
      ).findings,
    ).toEqual([{ source: '/source.txt', summary: 'Source A finding' }]);
    expect(() => s.files.get('chat-b', result.notes_path)).toThrow();
    expect(
      s.store.db.query('SELECT COUNT(*) AS n FROM assistant_outbox').get(),
    ).toEqual({ n: 0 });
    expect(
      s.store.db.query('SELECT COUNT(*) AS n FROM assistant_jobs').get(),
    ).toEqual({ n: 0 });
    await expect(
      executeResearchTool({ question: 'Again' }, s.ctx),
    ).rejects.toThrow('one research');
  } finally {
    s.store.close();
  }
});

test('reserves an outer final call and preserves notes on shared call exhaustion', async () => {
  const s = setup();
  try {
    s.store.addUsage('task-a', {
      llm_calls: 4,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    });
    s.responses.push(call('read_file', { file_path: '/source.txt' }));
    const result = await executeResearchTool({ question: 'Read' }, s.ctx);
    expect(result.status).toBe('limited');
    expect(s.calls()).toBe(1);
    expect(s.store.runUsage('task-a').llm_calls).toBe(5);
    expect(s.files.list('chat-a', '/research').length).toBe(1);
  } finally {
    s.store.close();
  }
});

test('monthly zero budget does not permit spending on a nested model call', async () => {
  const s = setup();
  try {
    s.ctx.config.inputPrice = 1;
    await expect(
      executeResearchTool({ question: 'Read' }, s.ctx),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(s.calls()).toBe(0);
    expect(s.store.monthSpend()).toBe(0);
  } finally {
    s.store.close();
  }
});

test('unavailable writes and foreign virtual paths cannot leak or change another chat', async () => {
  const s = setup();
  try {
    s.responses.push(
      call('read_file', { file_path: '/secret.txt' }),
      call('write_file', { file_path: '/injected.txt', content: 'malicious' }),
      { role: 'assistant', content: 'Read failed' },
    );
    await executeResearchTool({ question: 'Read source' }, s.ctx);
    expect(JSON.stringify(s.received)).not.toContain('SECRET_OTHER_CHAT');
    expect(() => s.files.get('chat-a', '/injected.txt')).toThrow();
    expect(s.files.get('chat-b', '/secret.txt').content.length).toBeGreaterThan(
      0,
    );
  } finally {
    s.store.close();
  }
});

test('browser job ownership and cleanup apply before model/tool execution', async () => {
  const s = setup();
  const slots = new BrowserSlots(1);
  const network = new BrowserNetworkPolicy(
    ['https://example.com'],
    async () => [{ address: '8.8.8.8', family: 4 }],
  );
  let starts = 0;
  const job = new ReadOnlyBrowserJob(
    () => {
      starts++;
      throw new Error('Must not start');
    },
    network,
    s.ctx.signal,
    slots,
    { chatId: 'chat-b', taskId: 'task-b' },
  );
  try {
    await expect(
      executeResearchTool({ question: 'Read' }, s.ctx, { browser: job }),
    ).rejects.toThrow('another chat');
    expect(starts).toBe(0);
    expect(s.calls()).toBe(0);
    await job.close();
    const own = new ReadOnlyBrowserJob(
      () => {
        starts++;
        throw new Error('Must not start');
      },
      network,
      s.ctx.signal,
      slots,
      { chatId: 'chat-a', taskId: 'task-a' },
    );
    await expect(
      executeResearchTool({ question: '' }, s.ctx, { browser: own }),
    ).rejects.toThrow();
    expect(slots.count()).toBe(0);
    expect(starts).toBe(0);
  } finally {
    await job.close();
    s.store.close();
  }
});

test('research definition advertises available URL reads without promising active browsing/search', () => {
  const tool = researchToolDefinitions()[0];
  expect(tool.function.name).toBe('research');
  expect(tool.function.description).toContain(
    'Supplied public links work without search',
  );
  expect(tool.function.description).toContain('approved worker');
});

test('optional configured search retains the parent allowance without any real request', async () => {
  const s = setup();
  const original = globalThis.fetch;
  let requests = 0;
  s.ctx.config.braveKey = 'synthetic-key-only';
  s.ctx.config.maxSearches = 1;
  const search = call('search_web', { query: 'synthetic source' });
  search.tool_calls!.push({ ...search.tool_calls![0], id: 'second-search' });
  s.responses.push(search, {
    role: 'assistant',
    content: 'Synthetic search synthesis',
  });
  globalThis.fetch = (async (url, init) => {
    requests++;
    expect(String(url)).toContain('api.search.brave.com/res/v1/web/search');
    expect(init?.signal).toBeDefined();
    return Response.json({
      web: {
        results: [
          {
            title: 'Synthetic',
            url: 'https://example.com',
            description: 'Synthetic excerpt',
          },
        ],
      },
    });
  }) as typeof fetch;
  try {
    const result = (await executeTool(
      'research',
      JSON.stringify({ question: 'Search synthetic source' }),
      s.ctx,
    )) as { status: string };
    expect(result.status).toBe('complete');
    expect(requests).toBe(1);
    expect(s.ctx.searches).toBe(1);
    expect(s.calls()).toBe(2);
    expect(s.store.runUsage('task-a').llm_calls).toBe(2);
    expect(s.store.monthSpend()).toBe(0);
  } finally {
    globalThis.fetch = original;
    s.store.close();
  }
});

for (const maximum of [4, 5])
  test(`registered parent-to-subagent-to-final path stays within ${maximum} shared calls`, async () => {
    const s = setup();
    s.ctx.config.maxCalls = maximum;
    let outer = 0;
    let inner = 0;
    const snapshots: { kind: string; messages: LlmMessage[] }[] = [];
    const visible: string[] = [];
    s.ctx.llm = {
      complete: async (messages, tools, _signal, onContent) => {
        const parent = tools.some((tool) => tool.function.name === 'research');
        if (parent) {
          expect(typeof onContent).toBe('function');
          onContent?.('Visible parent snapshot');
        } else expect(onContent).toBeUndefined();
        snapshots.push({
          kind: parent ? 'parent' : 'child',
          messages: structuredClone(messages),
        });
        let message: LlmMessage;
        if (parent) {
          if (++outer === 1)
            message = call('research', {
              question: 'Read source A',
              inputs: ['/source.txt'],
            });
          else {
            const result = JSON.parse(messages.at(-1)!.content!);
            expect(result.status).toBe(maximum === 4 ? 'limited' : 'complete');
            expect(result.findings).toEqual([
              { source: '/source.txt', summary: 'Source A finding' },
            ]);
            message = {
              role: 'assistant',
              content: 'Final synthetic answer with source /source.txt',
            };
          }
        } else {
          inner++;
          if (inner === 1)
            message = call('read_file', { file_path: '/source.txt' });
          else if (inner === 2)
            message = call('record_finding', {
              source: '/source.txt',
              summary: 'Source A finding',
            });
          else message = { role: 'assistant', content: 'Source A synthesis' };
        }
        return {
          message,
          usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0 },
        };
      },
    };
    try {
      expect(
        toolDefinitions(false).map((tool) => tool.function.name),
      ).toContain('research');
      expect(
        toolDefinitions(false).map((tool) => tool.function.name),
      ).toContain('read_url');
      expect(
        toolDefinitions(false).map((tool) => tool.function.name),
      ).not.toContain('search_web');
      const answer = await runAssistant({
        config: s.ctx.config,
        store: s.store,
        analytics: s.ctx.analytics!,
        llm: s.ctx.llm!,
        request: s.ctx.request,
        taskId: s.ctx.taskId,
        signal: s.ctx.signal,
        onContent: (text) => {
          visible.push(text);
        },
      });
      expect(answer).toContain('Final synthetic answer');
      expect(s.store.runUsage('task-a').llm_calls).toBe(maximum);
      expect(s.store.monthSpend()).toBe(0);
      expect(
        JSON.stringify(
          snapshots.filter((snapshot) => snapshot.kind === 'child'),
        ),
      ).not.toContain('PARENT_HISTORY_NOT_IN_SUBAGENT');
      expect(JSON.stringify(snapshots)).not.toContain('SECRET_OTHER_CHAT');
      expect(s.files.list('chat-a', '/research').length).toBe(1);
      expect(visible).toEqual([
        '',
        'Visible parent snapshot',
        '',
        'Visible parent snapshot',
      ]);
    } finally {
      s.store.close();
    }
  });
