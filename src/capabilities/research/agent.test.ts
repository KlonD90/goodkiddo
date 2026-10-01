import { describe, it, expect, vi } from 'vitest';
import { runResearch, researchSchema, type ResearchTool } from './agent.js';
import { ResearchNotes } from './notes.js';
import type { LlmMessage } from '../../shared/assistant-types.js';

const brief = () =>
  researchSchema.parse({ question: 'Compare supplied sources' });
const call = (name: string, args: unknown, id = 'call'): LlmMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const read: ResearchTool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_url',
      description: 'Synthetic read',
      parameters: {},
    },
  },
  execute: async () => ({
    url: 'https://example.com/',
    text: 'Untrusted source',
    untrusted: true,
  }),
};

describe('bounded research subagent', () => {
  it('keeps tool context local and records only a source successfully read', async () => {
    const notes = new ResearchNotes();
    const responses = [
      call('read_url', { url: 'https://example.com/' }),
      call('record_finding', {
        source: 'https://example.com/',
        summary: 'Synthetic finding',
      }),
      {
        role: 'assistant',
        content: 'Synthesis https://example.com/',
      } as LlmMessage,
    ];
    const complete = vi.fn(async () => responses.shift()!);
    const result = await runResearch({
      brief: brief(),
      notes,
      tools: [read],
      signal: new AbortController().signal,
      complete,
    });
    expect(result.status).toBe('complete');
    expect(notes.snapshot()).toEqual([
      { source: 'https://example.com/', summary: 'Synthetic finding' },
    ]);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(JSON.parse(notes.serialize()).untrusted).toBe(true);
  });
  it('refuses a mutable or recursive tool registry', async () => {
    for (const name of [
      'research',
      'write_file',
      'send_file',
      'execute',
      'create_reminder',
    ]) {
      await expect(
        runResearch({
          brief: brief(),
          notes: new ResearchNotes(),
          tools: [
            {
              ...read,
              definition: {
                ...read.definition,
                function: { ...read.definition.function, name },
              },
            },
          ],
          signal: new AbortController().signal,
          complete: vi.fn(),
        }),
      ).rejects.toThrow('registry');
    }
  });
  it('cannot invoke an invented write tool despite source instructions', async () => {
    const execute = vi.fn(read.execute);
    const responses = [
      call('send_file', { file_path: '/private' }),
      { role: 'assistant', content: 'Unavailable' } as LlmMessage,
    ];
    const complete = vi.fn(async (messages: LlmMessage[]) => {
      if (responses.length === 1)
        expect(messages.at(-1)?.content).toContain('Do not claim success');
      return responses.shift()!;
    });
    await runResearch({
      brief: brief(),
      notes: new ResearchNotes(),
      tools: [{ ...read, execute }],
      signal: new AbortController().signal,
      complete,
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects fabricated finding sources', () => {
    const notes = new ResearchNotes();
    expect(() => notes.add('https://unread.example', 'fabricated')).toThrow(
      'not been read',
    );
    notes.observe({ url: 'https://example.com' });
    notes.add('https://example.com', 'actual');
    const snapshot = notes.snapshot();
    snapshot[0].summary = 'mutated';
    expect(notes.snapshot()[0].summary).toBe('actual');
  });
  it('returns bounded partial status rather than exhausting recursion', async () => {
    const complete = vi.fn(async () => call('read_url', {}));
    const result = await runResearch({
      brief: researchSchema.parse({ question: 'Read', depth: 'quick' }),
      notes: new ResearchNotes(),
      tools: [read],
      signal: new AbortController().signal,
      complete,
    });
    expect(result.status).toBe('limited');
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it('propagates shared budget failures instead of treating them as page failures', async () => {
    const budget = new Error('shared budget');
    await expect(
      runResearch({
        brief: brief(),
        notes: new ResearchNotes(),
        tools: [
          {
            ...read,
            execute: () => {
              throw budget;
            },
          },
        ],
        signal: new AbortController().signal,
        complete: async () => call('read_url', {}),
        fatalError: (error) => error === budget,
      }),
    ).rejects.toBe(budget);
  });
  it('cancels a stalled completion', async () => {
    const cancel = new AbortController();
    const pending = runResearch({
      brief: brief(),
      notes: new ResearchNotes(),
      tools: [read],
      signal: cancel.signal,
      complete: () => new Promise(() => {}),
    });
    cancel.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  });
  it('rejects many calls or excessive model output', async () => {
    const many = call('read_url', {});
    many.tool_calls = Array(5).fill(many.tool_calls![0]);
    for (const message of [
      many,
      { role: 'assistant', content: 'x'.repeat(24_001) } as LlmMessage,
    ]) {
      await expect(
        runResearch({
          brief: brief(),
          notes: new ResearchNotes(),
          tools: [read],
          signal: new AbortController().signal,
          complete: async () => message,
        }),
      ).rejects.toThrow('output');
    }
  });
});
