import { describe, expect, it } from 'vitest';
import { readCompletionStream } from './assistant-stream.js';
import { withImages } from './assistant-vision.js';

function stream(events: unknown[], complete = true): Response {
  const source =
    events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('') +
    (complete ? 'data: [DONE]\n\n' : '');
  const bytes = new TextEncoder().encode(source);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7)
          controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
  );
}
describe('compatible SSE', () => {
  it('returns visible content and usage without reasoning', async () => {
    const previews: string[] = [];
    const result = await readCompletionStream(
      stream([
        {
          choices: [
            { index: 0, delta: { reasoning_content: 'do not reveal' } },
          ],
        },
        { choices: [{ index: 0, delta: { content: 'Привет' } }] },
        {
          choices: [
            { index: 0, delta: { content: ' 🌍' }, finish_reason: 'stop' },
          ],
        },
        { choices: [], usage: { prompt_tokens: 4, completion_tokens: 3 } },
      ]),
      new AbortController().signal,
      (text) => previews.push(text),
    );
    expect(previews).toEqual(['Привет', 'Привет 🌍']);
    expect(result).toEqual({
      message: { role: 'assistant', content: 'Привет 🌍' },
      usage: { prompt_tokens: 4, completion_tokens: 3 },
    });
    expect(JSON.stringify(result)).not.toContain('reasoning');
  });
  it('reassembles fragmented tool calls', async () => {
    const result = await readCompletionStream(
      stream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-1',
                    function: { name: 'read_url', arguments: '{"url":' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"https://example.com"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]),
      new AbortController().signal,
      () => {},
    );
    expect(result.message.tool_calls?.[0]).toEqual({
      id: 'call-1',
      type: 'function',
      function: {
        name: 'read_url',
        arguments: '{"url":"https://example.com"}',
      },
    });
  });
  it('rejects truncated streams', async () => {
    await expect(
      readCompletionStream(
        stream([{ choices: [{ delta: { content: 'partial' } }] }], false),
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow('Incomplete');
  });
  it('does not mutate history when attaching images', () => {
    const history = [{ role: 'user' as const, content: 'Look' }];
    const png = {
      filename: 'test.png',
      mimeType: 'image/png',
      bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    };
    expect(Array.isArray(withImages(history, [png])[0].content)).toBe(true);
    expect(history[0].content).toBe('Look');
    expect(() =>
      withImages(history, [{ ...png, mimeType: 'image/jpeg' }]),
    ).toThrow();
  });
});
