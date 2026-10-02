import { expect, test } from 'bun:test';
import { syntheticConfig } from '../src/assistant/core-test-fixtures.js';
import {
  loadContextConfig,
  SPACE_BUNNY_METADATA,
} from '../src/config/assistant-context-config.js';
import {
  assertRequestFits,
  contextLimits,
  messageTokens,
  requestTokens,
  selectHistory,
} from '../src/providers/assistant-context-budget.js';
import type { LlmMessage } from '../src/shared/assistant-types.js';

const system: LlmMessage = { role: 'system', content: 'instructions' };
const current: LlmMessage[] = [{ role: 'user', content: 'latest request' }];
const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'read',
      description: 'read data',
      parameters: { type: 'object' },
    },
  },
];

test('official pinned metadata resolves model window; unknown model requires evidence-backed override', () => {
  const empty = () => undefined;
  const known = loadContextConfig(
    'https://opencode.ai/inference/openai/v1',
    'space-bunny-free',
    empty,
  );
  expect(known.windowTokens).toBe(1_048_576);
  expect(known.inputTokens).toBe(524_288);
  expect(known.source).toBe(SPACE_BUNNY_METADATA.source);
  expect(() =>
    loadContextConfig('https://example.invalid', 'unknown', empty),
  ).toThrow('Set LLM_CONTEXT_WINDOW');
  const settings: Record<string, string> = {
    LLM_CONTEXT_WINDOW_TOKENS: '32000',
    LLM_CONTEXT_METADATA_SOURCE:
      'https://example.invalid/official-model-metadata',
  };
  expect(
    loadContextConfig('https://example.invalid', 'unknown', (k) => settings[k])
      .windowTokens,
  ).toBe(32000);
  delete settings.LLM_CONTEXT_METADATA_SOURCE;
  expect(() =>
    loadContextConfig('https://example.invalid', 'unknown', (k) => settings[k]),
  ).toThrow('Invalid');
  settings.LLM_CONTEXT_METADATA_SOURCE =
    'https://example.invalid/official-model-metadata';
  settings.LLM_CONTEXT_WINDOW_TOKENS = '200000.1';
  expect(() =>
    loadContextConfig('https://example.invalid', 'unknown', (k) => settings[k]),
  ).toThrow('Invalid');
});
test('min(model window,200k) includes output reserve and separate provider input limit', () => {
  const config = syntheticConfig();
  config.maxOutputTokens = 1800;
  config.context = { ...SPACE_BUNNY_METADATA };
  expect(contextLimits(config)).toEqual({
    total: 200_000,
    output: 1800,
    input: 198_200,
  });
  config.context.windowTokens = 32_000;
  expect(contextLimits(config).input).toBe(30_200);
  config.context.inputTokens = 16_000;
  expect(contextLimits(config).input).toBe(16_000);
  config.maxOutputTokens = 32_000;
  expect(() => contextLimits(config)).toThrow('Резерв');
  config.context = undefined as any;
  expect(() => contextLimits(config)).toThrow('Окно');
});
test('whole-request accounting includes system, memory, tools, JSON arguments/results and UTF-8', () => {
  const config = syntheticConfig();
  const messages: LlmMessage[] = [
    system,
    ...current,
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call',
          type: 'function',
          function: { name: 'read', arguments: '{"key":"данные"}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call',
      content: 'Длинные данные 🙂'.repeat(500),
    },
  ];
  const count = requestTokens(messages, tools, config);
  config.context.windowTokens = count + config.maxOutputTokens;
  expect(assertRequestFits(messages, tools, config)).toBe(count);
  config.context.windowTokens--;
  expect(() => assertRequestFits(messages, tools, config)).toThrow('превышает');
  expect(messageTokens({ role: 'user', content: '🙂' })).toBeGreaterThan(
    messageTokens({ role: 'user', content: 'x' }),
  );
  expect(
    requestTokens(
      [...messages, { role: 'system', content: 'stored fact'.repeat(100) }],
      tools,
      syntheticConfig(),
    ),
  ).toBeGreaterThan(count);
});
test('history selection uses tokens with no 12/24-message limit or fragment clipping', () => {
  const config = syntheticConfig();
  const history: LlmMessage[] = Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `complete source ${i}`,
  }));
  expect(
    selectHistory({ system, current, history, tools, config }),
  ).toHaveLength(202);
  config.context.windowTokens = 3000;
  const selected = selectHistory({ system, current, history, tools, config });
  expect(selected.length).toBeLessThan(202);
  expect(selected.at(-1)).toEqual(current[0]);
  expect(selected[1].content).toContain('history_search');
  expect(
    selected.slice(2, -1).every((message) => history.includes(message)),
  ).toBe(true);
  expect(assertRequestFits(selected, tools, config)).toBeLessThanOrEqual(
    contextLimits(config).input,
  );
  expect(history).toHaveLength(200);
  expect(() =>
    selectHistory({
      system,
      history,
      tools,
      config,
      current: [{ role: 'user', content: 'mandatory'.repeat(1000) }],
    }),
  ).toThrow('превышает');
});
test('unknown image tokenization fails closed; verified vision upper bound is independent of base64 bytes', () => {
  const config = syntheticConfig();
  const image = {
    filename: 'synthetic.png',
    mimeType: 'image/png',
    bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
  };
  expect(() => assertRequestFits(current, [], config, [image])).toThrow(
    'изображения',
  );
  config.context.imageTokens = 4096;
  config.context.imageSource = 'synthetic verified ceiling';
  const textTokens = requestTokens(current, [], config);
  expect(requestTokens(current, [], config, [image])).toBe(
    textTokens + 4096 + 256,
  );
  expect(
    requestTokens(current, [], config, [
      {
        ...image,
        bytes: new Uint8Array([...image.bytes, ...new Uint8Array(10000)]),
      },
    ]),
  ).toBe(textTokens + 4096 + 256);
  config.context.windowTokens =
    textTokens + 4096 + 256 + config.maxOutputTokens;
  expect(assertRequestFits(current, [], config, [image])).toBe(
    textTokens + 4096 + 256,
  );
  config.context.windowTokens--;
  expect(() => assertRequestFits(current, [], config, [image])).toThrow(
    'превышает',
  );
});
