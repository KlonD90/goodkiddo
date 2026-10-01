import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AssistantStore } from '../persistence/assistant-store.js';
import { AssistantAnalytics } from '../integrations/assistant-analytics.js';
import type { AssistantConfig } from '../config/assistant-config.js';
import { coreToolDefinitions, executeCoreTool } from './core-tools.js';
import { runAssistant } from './agent.js';
import type { ToolContext } from './tools.js';

const roots: string[] = [];
const stores: AssistantStore[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'goodkiddo-core-'));
  roots.push(root);
  const file = path.join(root, 'test.db');
  const store = new AssistantStore(file);
  stores.push(store);
  const chat = {
    id: 'synthetic-a',
    type: 'private' as const,
    timezone: 'UTC',
    active: 1,
  };
  store.saveChat(chat);
  return { store, file, chat };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test('rolling history archives old messages and persists a digest across reopen', () => {
  const { store, file } = fixture();
  for (let i = 0; i < 60; i++)
    store.remember('synthetic-a', 'user', `decision-${i}`);
  expect(store.history('synthetic-a')).toHaveLength(24);
  expect(store.memory.summary('synthetic-a')).toContain('decision-0');
  expect(store.memory.search('synthetic-a', 'decision-0')).toHaveLength(1);
  const reopened = new AssistantStore(file);
  stores.push(reopened);
  expect(reopened.memory.search('synthetic-a', 'decision-0')).toHaveLength(1);
  expect(reopened.memory.summary('synthetic-a')).toContain('decision-0');
});
test('history and memory searches stay within the chat and escape LIKE wildcards', () => {
  const { store } = fixture();
  store.remember('synthetic-a', 'user', 'literal 100%_tag');
  store.remember('synthetic-b', 'user', 'other chat');
  expect(store.memory.search('synthetic-a', '100%_')).toHaveLength(1);
  expect(store.memory.search('synthetic-a', 'other chat')).toEqual([]);
  expect(store.memory.search('synthetic-a', '%')).toHaveLength(1);
});
test('facts, preferences and skills persist with per-author ownership', () => {
  const { store, file } = fixture();
  store.memory.write(
    'synthetic-a',
    'actor-a',
    'language',
    'Русский',
    'preference',
  );
  expect(() =>
    store.memory.write('synthetic-a', 'actor-b', 'language', 'other', 'fact'),
  ).toThrow();
  expect(() =>
    store.memory.remove('synthetic-a', 'actor-b', 'language'),
  ).toThrow();
  const reopened = new AssistantStore(file);
  stores.push(reopened);
  expect(reopened.memory.list('synthetic-a')[0]?.content).toBe('Русский');
  expect(reopened.memory.list('synthetic-b')).toEqual([]);
  store.memory.remove('synthetic-a', 'actor-a', 'language');
  expect(store.memory.list('synthetic-a')).toEqual([]);
});
test('clear removes archive and summary while preserving explicit memory and TODOs', () => {
  const { store } = fixture();
  store.remember('synthetic-a', 'user', 'old dialogue');
  store.memory.setSummary('synthetic-a', 'old summary');
  store.memory.write(
    'synthetic-a',
    'actor-a',
    'preference',
    'tea',
    'preference',
  );
  store.todos.add('synthetic-a', 'actor-a', 'buy tea', 'origin-a');
  store.remember('synthetic-b', 'user', 'other chat');
  store.forget('synthetic-a');
  expect(store.history('synthetic-a')).toEqual([]);
  expect(store.memory.summary('synthetic-a')).toBe('');
  expect(store.memory.search('synthetic-a', 'old')).toEqual([]);
  expect(store.memory.list('synthetic-a')).toHaveLength(1);
  expect(store.todos.list('synthetic-a')).toHaveLength(1);
  expect(store.history('synthetic-b')).toHaveLength(1);
});
test('TODO creation is idempotent and restart-safe', () => {
  const { store, file } = fixture();
  const todo = store.todos.add('synthetic-a', 'actor-a', 'Plan', 'origin-a');
  expect(store.todos.add('synthetic-a', 'actor-a', 'Plan', 'origin-a').id).toBe(
    todo.id,
  );
  expect(store.todos.list('synthetic-a')).toHaveLength(1);
  const reopened = new AssistantStore(file);
  stores.push(reopened);
  expect(reopened.todos.list('synthetic-a')[0]?.id).toBe(todo.id);
});
test('TODOs support edit/complete/dismiss/reopen with chat and owner authorization', () => {
  const { store } = fixture();
  const todo = store.todos.add('synthetic-a', 'actor-a', 'Plan', 'origin-a');
  expect(() =>
    store.todos.update('synthetic-b', 'actor-a', todo.id, { status: 'done' }),
  ).toThrow();
  expect(() =>
    store.todos.update('synthetic-a', 'actor-b', todo.id, { status: 'done' }),
  ).toThrow();
  store.todos.update('synthetic-a', 'actor-a', todo.id, {
    title: 'New plan',
    status: 'done',
  });
  expect(store.todos.list('synthetic-a')).toEqual([]);
  expect(store.todos.list('synthetic-a', 'done')[0]?.title).toBe('New plan');
  store.todos.update('synthetic-a', 'actor-a', todo.id, {
    status: 'dismissed',
  });
  expect(store.todos.list('synthetic-a', 'dismissed')).toHaveLength(1);
  store.todos.update('synthetic-a', 'actor-a', todo.id, { status: 'open' });
  expect(store.todos.list('synthetic-a')).toHaveLength(1);
});
test('memory size and open TODO limits are enforced', () => {
  const { store } = fixture();
  expect(() =>
    store.memory.setSummary('synthetic-a', 'x'.repeat(16001)),
  ).toThrow();
  expect(() =>
    store.memory.write(
      'synthetic-a',
      'actor-a',
      'key',
      'x'.repeat(4001),
      'fact',
    ),
  ).toThrow();
  for (let i = 0; i < 100; i++)
    store.memory.write('synthetic-a', 'actor-a', `key-${i}`, 'value', 'fact');
  expect(() =>
    store.memory.write('synthetic-a', 'actor-a', 'overflow', 'value', 'fact'),
  ).toThrow();
  for (let i = 0; i < 200; i++)
    store.todos.add('synthetic-a', 'actor-a', `todo-${i}`, `origin-${i}`);
  expect(() =>
    store.todos.add('synthetic-a', 'actor-a', 'overflow', 'overflow'),
  ).toThrow();
});
test('core tool registry dispatches actual TODO and memory writes', () => {
  const { store, chat } = fixture();
  const ctx = {
    store,
    taskId: 'synthetic-task',
    request: {
      updateId: 1,
      chat,
      actor: { id: 'actor-a', name: 'Synthetic' },
      text: 'test',
      interaction: 'message',
    },
  } as ToolContext;
  expect(coreToolDefinitions().map((tool) => tool.function.name)).toContain(
    'todo_add',
  );
  executeCoreTool('todo_add', '{"title":"Plan"}', ctx);
  executeCoreTool('todo_add', '{"title":"Plan"}', ctx);
  expect(store.todos.list(chat.id)).toHaveLength(1);
  executeCoreTool(
    'memory_write',
    '{"key":"language","content":"Русский"}',
    ctx,
  );
  expect(store.memory.list(chat.id)).toHaveLength(1);
});
test('agent advertises and executes core tools and injects stored memory on next turn', async () => {
  const { store, chat } = fixture();
  const config = {
    maxCalls: 3,
    braveKey: undefined,
    monthlyBudget: 0,
    inputPrice: 0,
    outputPrice: 0,
    maxOutputTokens: 100,
    model: 'fake',
    provider: 'fake',
  } as AssistantConfig;
  const analytics = new AssistantAnalytics(config, store);
  const request = {
    updateId: 1,
    chat,
    actor: { id: 'actor-a', name: 'Synthetic' },
    text: 'test',
    interaction: 'message' as const,
  };
  analytics.start('synthetic-task', chat, request.actor.id, 'other', 'user');
  let calls = 0;
  const llm = {
    async complete(messages: any[], tools: any[]) {
      expect(tools.some((tool) => tool.function.name === 'memory_write')).toBe(
        true,
      );
      calls++;
      if (calls === 1)
        return {
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [
              {
                id: 'tool-a',
                type: 'function' as const,
                function: {
                  name: 'memory_write',
                  arguments: '{"key":"language","content":"Русский"}',
                },
              },
            ],
          },
        };
      expect(messages[0].content).toContain('Русский');
      return { message: { role: 'assistant' as const, content: 'saved' } };
    },
  };
  expect(
    await runAssistant({
      config,
      store,
      analytics,
      llm,
      request,
      taskId: 'synthetic-task',
      signal: new AbortController().signal,
    }),
  ).toBe('saved');
  expect(calls).toBe(2);
});
