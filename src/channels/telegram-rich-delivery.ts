import { TelegramApiError } from './telegram-assistant-api.js';

export interface TelegramCaller {
  call<T>(method: string, body: Record<string, unknown>): Promise<T>;
}
export interface RichTarget {
  chatId: string;
  threadId?: number;
}
interface MessageResult {
  message_id: number;
}
export function confirmedMessageId(
  result: { message_id?: number } | undefined,
): number {
  if (
    !Number.isSafeInteger(result?.message_id) ||
    (result?.message_id ?? 0) <= 0
  )
    throw new TelegramApiError(0);
  return result!.message_id!;
}
export function unsupportedRichMethod(error: unknown): boolean {
  // A transport timeout or 5xx may have accepted the request. Never send a fallback then.
  return error instanceof TelegramApiError && error.code === 404;
}
export function richMarkdown(text: string): { markdown: string } {
  // Rich markdown supports media/HTML. Bot-generated text must not trigger remote media fetches.
  let fence: { char: string; length: number } | undefined;
  const escape = (value: string) =>
    value
      .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, '$1')
      .replace(/<[^>]*>/g, (match) =>
        match.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      );
  const safe = text
    .split('\n')
    .map((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (marker) {
        if (!fence) fence = { char: marker[1][0], length: marker[1].length };
        else if (
          marker[1][0] === fence.char &&
          marker[1].length >= fence.length &&
          !marker[2].trim()
        )
          fence = undefined;
        return line;
      }
      if (fence) return line;
      return line
        .split(/(`+[^`\n]*`+)/g)
        .map((part) => (part.startsWith('`') ? part : escape(part)))
        .join('');
    })
    .join('\n');
  if ([...safe].length > 32_768)
    throw new Error('Rich reply exceeds Telegram limit');
  return { markdown: safe };
}

export class TelegramRichDelivery {
  private supported = true;
  constructor(private readonly api: TelegramCaller) {}
  async send(
    target: RichTarget,
    text: string,
    markup?: unknown,
  ): Promise<number | undefined> {
    const body = {
      chat_id: target.chatId,
      message_thread_id: target.threadId,
      reply_markup: markup,
    };
    if (this.supported) {
      try {
        const result = await this.api.call<MessageResult>('sendRichMessage', {
          ...body,
          rich_message: richMarkdown(text),
        });
        return confirmedMessageId(result);
      } catch (error) {
        if (!unsupportedRichMethod(error)) throw error;
        this.supported = false;
      }
    }
    const result = await this.api.call<MessageResult>('sendMessage', {
      ...body,
      text,
      link_preview_options: { is_disabled: true },
    });
    return confirmedMessageId(result);
  }
  async draft(
    target: RichTarget,
    draftId: number,
    text: string,
  ): Promise<void> {
    if (!Number.isSafeInteger(draftId) || draftId === 0)
      throw new Error('Draft ID must be non-zero');
    await this.api.call('sendRichMessageDraft', {
      chat_id: Number(target.chatId),
      message_thread_id: target.threadId,
      draft_id: draftId,
      rich_message: richMarkdown(text),
    });
  }
  async beginGroupPreview(target: RichTarget, text: string): Promise<number> {
    const message = await this.api.call<MessageResult>('sendRichMessage', {
      chat_id: target.chatId,
      message_thread_id: target.threadId,
      rich_message: richMarkdown(text),
    });
    return message.message_id;
  }
  async editGroupPreview(
    target: RichTarget,
    messageId: number,
    text: string,
    markup?: unknown,
  ): Promise<void> {
    try {
      await this.api.call('editMessageText', {
        chat_id: target.chatId,
        message_id: messageId,
        rich_message: richMarkdown(text),
        reply_markup: markup,
      });
    } catch (error) {
      if (error instanceof TelegramApiError && error.reason === 'not_modified')
        return;
      throw error;
    }
  }
}
