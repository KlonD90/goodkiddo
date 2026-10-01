import { test, expect } from 'bun:test';
import {
  loadBrowserConfig,
  APPROVED_BROWSER_SOCKET,
} from '../src/config/assistant-browser-config.ts';
import { AssistantStore } from '../src/persistence/assistant-store.ts';
import { AssistantAnalytics } from '../src/integrations/assistant-analytics.ts';
import { runAssistant } from '../src/assistant/agent.ts';
import {
  BrowserSlots,
  ReadOnlyBrowserJob,
} from '../src/capabilities/browser/job.ts';
import { BrowserNetworkPolicy } from '../src/capabilities/browser/network-policy.ts';
import type { BrowserResearchRuntime } from '../src/assistant/browser-runtime.ts';
import type { AssistantLlm } from '../src/providers/assistant-llm.ts';
import { fileConfig } from './fixtures/file-assistant-config.ts';
import type { LlmMessage } from '../src/shared/assistant-types.ts';

test('browser bootstrap is disabled by default and accepts only the approved private socket', () => {
  expect(loadBrowserConfig(() => undefined)).toEqual({});
  expect(loadBrowserConfig(() => '')).toEqual({});
  expect(loadBrowserConfig(() => APPROVED_BROWSER_SOCKET)).toEqual({
    browserSocket: APPROVED_BROWSER_SOCKET,
  });
  for (const socket of [
    '/tmp/foreign.sock',
    '/var/run/docker.sock',
    'http://127.0.0.1',
    'worker.sock',
  ])
    expect(() => loadBrowserConfig(() => socket)).toThrow(
      'Invalid ASSISTANT_BROWSER_SOCKET',
    );
});

test('registered parent and research child receive same-chat browser rendering and close it before final reply', async () => {
  const config = fileConfig();
  const store = new AssistantStore(':memory:');
  const chat = {
    id: 'synthetic-chat',
    type: 'private' as const,
    timezone: 'UTC',
    active: 1,
  };
  const request = {
    updateId: 1,
    chat,
    actor: { id: 'synthetic-user', name: 'Synthetic' },
    text: 'Read the supplied public documentation',
    interaction: 'message' as const,
  };
  const taskId = 'synthetic-browser-integration';
  store.saveChat(chat);
  store.startRun(taskId, chat, request.actor.id, 'other');
  const slots = new BrowserSlots(1);
  let opens = 0,
    disposed = 0,
    modelCalls = 0,
    outer = 0,
    inner = 0;
  const commands: (readonly string[])[] = [];
  const browser = {
    open(chatId: string, ownerTask: string, signal: AbortSignal) {
      opens++;
      expect(chatId).toBe(chat.id);
      expect(ownerTask).toBe(taskId);
      return new ReadOnlyBrowserJob(
        () => ({
          run: async ({ argv }) => {
            commands.push(argv);
            const text = argv.includes('snapshot')
              ? 'Synthetic rendered documentation'
              : argv.includes('get')
                ? 'https://example.com/'
                : '';
            return { stdout: text, stderr: '', exitCode: 0 };
          },
          dispose: async () => {
            disposed++;
          },
        }),
        new BrowserNetworkPolicy(['https://example.com'], async () => [
          { address: '8.8.8.8', family: 4 },
        ]),
        signal,
        slots,
        { chatId, taskId: ownerTask },
      );
    },
  } as unknown as BrowserResearchRuntime;
  const tool = (name: string, args: unknown): LlmMessage => ({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: name,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  const llm: AssistantLlm = {
    complete: async (messages, tools) => {
      modelCalls++;
      const parent = tools.some((t) => t.function.name === 'research');
      let message: LlmMessage;
      if (parent && ++outer === 1)
        message = tool('research', {
          question: 'Render supplied public documentation',
          inputs: ['https://example.com/'],
        });
      else if (parent) {
        expect(disposed).toBe(1);
        expect(slots.count()).toBe(0);
        expect(messages.at(-1)?.content).toContain(
          'Synthetic rendered documentation',
        );
        message = { role: 'assistant', content: 'Final synthetic answer' };
      } else if (++inner === 1) {
        expect(tools.some((t) => t.function.name === 'browser_snapshot')).toBe(
          true,
        );
        expect(
          tools.some((t) =>
            ['send_file', 'write_file', 'create_reminder'].includes(
              t.function.name,
            ),
          ),
        ).toBe(false);
        message = tool('browser_snapshot', { url: 'https://example.com/' });
      } else {
        expect(messages.at(-1)?.content).toContain(
          'Synthetic rendered documentation',
        );
        message = {
          role: 'assistant',
          content: 'Synthetic rendered documentation finding',
        };
      }
      return {
        message,
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      };
    },
  };
  try {
    const result = await runAssistant({
      config,
      store,
      analytics: new AssistantAnalytics(config, store),
      llm,
      request,
      taskId,
      signal: new AbortController().signal,
      browser,
    });
    expect(result).toBe('Final synthetic answer');
    expect(opens).toBe(1);
    expect(modelCalls).toBe(4);
    expect(commands).toHaveLength(3);
    expect(store.runUsage(taskId).llm_calls).toBe(4);
    expect(store.monthSpend()).toBe(0);
    expect(
      store.db.query('SELECT COUNT(*) n FROM assistant_outbox').get(),
    ).toEqual({ n: 0 });
  } finally {
    store.close();
  }
});
