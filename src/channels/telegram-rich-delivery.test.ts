import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramApiError } from './telegram-assistant-api.js';
import {
  TelegramRichDelivery,
  richMarkdown,
} from './telegram-rich-delivery.js';
import { TelegramDraftStream } from './telegram-draft-stream.js';

afterEach(() => vi.useRealTimers());
describe('rich Telegram transport', () => {
  it('sends native Markdown table with one rich format field', async () => {
    const call = vi.fn(
      async (_method: string, _body: Record<string, unknown>) => ({
        message_id: 123,
      }),
    );
    const delivery = new TelegramRichDelivery({ call } as never);
    await delivery.send({ chatId: '1' }, '| A | B |\n|---|---|\n| 1 | 2 |');
    expect(call.mock.calls[0][0]).toBe('sendRichMessage');
    expect(call.mock.calls[0][1].rich_message).toEqual({
      markdown: '| A | B |\n|---|---|\n| 1 | 2 |',
    });
  });
  it('falls back only for a definitive unavailable method', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new TelegramApiError(404))
      .mockResolvedValue({ message_id: 123 });
    await new TelegramRichDelivery({ call }).send({ chatId: '1' }, '**Text**');
    expect(call.mock.calls.map((args) => args[0])).toEqual([
      'sendRichMessage',
      'sendMessage',
    ]);
    const uncertain = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(
      new TelegramRichDelivery({ call: uncertain }).send(
        { chatId: '1' },
        'Text',
      ),
    ).rejects.toThrow('timeout');
    expect(uncertain).toHaveBeenCalledTimes(1);
  });
  it('removes automatic media loading and escapes HTML', () => {
    expect(richMarkdown('![Photo](http://127.0.0.1/a) <tg-photo>')).toEqual({
      markdown: 'Photo &lt;tg-photo&gt;',
    });
    const code = '```html\n<img src="example">\n```\n`<div>`';
    expect(richMarkdown(code)).toEqual({ markdown: code });
  });
  it('coalesces drafts once per second and never finalizes them', async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockResolvedValue(true);
    const drafts = new TelegramDraftStream(
      { call },
      { chatId: '1', chatType: 'private', draftId: 7 },
    );
    drafts.update('A');
    await vi.advanceTimersByTimeAsync(1);
    drafts.update('AB');
    drafts.update('ABC');
    await vi.advanceTimersByTimeAsync(1000);
    await drafts.close();
    expect(
      call.mock.calls.map((args) => args[1].rich_message.markdown),
    ).toEqual(['A', 'ABC']);
    expect(
      call.mock.calls.every(
        (args) => args[0] === 'sendRichMessageDraft' && args[1].draft_id === 7,
      ),
    ).toBe(true);
    drafts.update('late');
    await vi.advanceTimersByTimeAsync(1000);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('does not draft in groups and honors flood wait', async () => {
    vi.useFakeTimers();
    const call = vi
      .fn()
      .mockRejectedValueOnce(new TelegramApiError(429, 3))
      .mockResolvedValue(true);
    const group = new TelegramDraftStream(
      { call },
      { chatId: '-1', chatType: 'group', draftId: 1 },
    );
    group.update('X');
    expect(call).not.toHaveBeenCalled();
    await group.close();
    const privateChat = new TelegramDraftStream(
      { call },
      { chatId: '1', chatType: 'private', draftId: 2 },
    );
    privateChat.update('A');
    await vi.advanceTimersByTimeAsync(1000);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(call).toHaveBeenCalledTimes(2);
    await privateChat.close();
  });
});
