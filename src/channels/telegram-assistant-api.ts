import type { Actor, ChatType } from '../shared/assistant-types.js';
import {
  confirmedMessageId,
  TelegramRichDelivery,
} from './telegram-rich-delivery.js';
import {
  boundedDocumentBody,
  TelegramFileError,
} from './telegram-document-body.js';
import {
  documentName,
  safeMimeType,
} from '../persistence/assistant-file-policy.js';

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
}
export interface TelegramChat {
  id: number;
  type: ChatType | 'channel';
}
export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  text?: string;
  caption?: string;
  date?: number;
  is_automatic_forward?: boolean;
  photo?: {
    file_id: string;
    file_unique_id?: string;
    width: number;
    height: number;
    file_size?: number;
  }[];
  voice?: {
    file_id: string;
    file_unique_id?: string;
    duration: number;
    mime_type?: string;
    file_size?: number;
  };
  document?: {
    file_id: string;
    file_unique_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  quote?: { text: string; position?: number; is_manual?: boolean };
  forward_origin?: {
    type: string;
    date: number;
    sender_user?: TelegramUser;
    sender_user_name?: string;
    sender_chat?: { title?: string; username?: string };
    chat?: { title?: string; username?: string };
  };
  reply_to_message?: {
    from?: TelegramUser;
    text?: string;
    caption?: string;
    date?: number;
    forward_origin?: TelegramMessage['forward_origin'];
  };
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    data?: string;
    message?: TelegramMessage;
  };
  my_chat_member?: {
    chat: TelegramChat;
    from: TelegramUser;
    old_chat_member: { status: string };
    new_chat_member: { status: string };
  };
}
export class TelegramApiError extends Error {
  constructor(
    readonly code: number,
    readonly retryAfter = 0,
    readonly reason?: 'not_modified',
  ) {
    super(`Telegram request failed (${code})`);
  }
}
export function telegramActor(user: TelegramUser): Actor {
  return {
    id: String(user.id),
    name:
      [user.first_name, user.last_name].filter(Boolean).join(' ') ||
      user.username ||
      'Участник',
    username: user.username,
  };
}

export class TelegramAssistantApi {
  private readonly controller = new AbortController();
  private readonly rich = new TelegramRichDelivery(this);
  constructor(private readonly token: string) {}
  async call<T>(
    method: string,
    body: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    return this.request<T>(
      method,
      JSON.stringify(body),
      {
        'Content-Type': 'application/json',
      },
      signal,
    );
  }
  private async request<T>(
    method: string,
    body: string | FormData,
    headers?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          signal: AbortSignal.any([
            this.controller.signal,
            AbortSignal.timeout(40_000),
            ...(signal ? [signal] : []),
          ]),
        },
      );
    } catch {
      throw new TelegramApiError(0);
    }
    let data: {
      ok: boolean;
      result: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      throw new TelegramApiError(response.ok ? 0 : response.status);
    }
    if (!response.ok || !data.ok)
      throw new TelegramApiError(
        data.error_code || response.status,
        data.parameters?.retry_after,
        data.description?.includes('message is not modified')
          ? 'not_modified'
          : undefined,
      );
    return data.result;
  }
  async downloadDocument(
    fileId: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const file = await this.call<{ file_path?: string; file_size?: number }>(
      'getFile',
      { file_id: fileId },
      signal,
    );
    if (file.file_size !== undefined && file.file_size > maxBytes)
      throw new TelegramFileError('Документ превышает допустимый размер.');
    const filePath = file.file_path;
    if (
      !filePath ||
      !/^[A-Za-z0-9_./-]+$/.test(filePath) ||
      filePath.startsWith('/') ||
      filePath.split('/').includes('..')
    )
      throw new TelegramFileError(
        'Telegram не предоставил корректный путь документа.',
      );
    try {
      const response = await fetch(
        `https://api.telegram.org/file/bot${this.token}/${filePath}`,
        {
          redirect: 'error',
          signal: AbortSignal.any([
            this.controller.signal,
            AbortSignal.timeout(40_000),
            ...(signal ? [signal] : []),
          ]),
        },
      );
      if (!response.ok)
        throw new TelegramFileError(
          'Сейчас документ недоступен для загрузки.',
          true,
        );
      return await boundedDocumentBody(response, maxBytes);
    } catch (error) {
      if (error instanceof TelegramFileError) throw error;
      throw new TelegramFileError(
        'Загрузка документа временно недоступна.',
        true,
      );
    }
  }
  async sendDocument(
    chatId: string,
    file: { filename: string; mime_type: string; content: Uint8Array },
    caption = '',
    threadId?: number,
  ): Promise<number | undefined> {
    const body = new FormData();
    body.set('chat_id', chatId);
    body.set('caption', caption);
    if (threadId !== undefined) body.set('message_thread_id', String(threadId));
    body.set('disable_content_type_detection', 'true');
    body.set(
      'document',
      new Blob([new Uint8Array(file.content)], {
        type: safeMimeType(file.mime_type),
      }),
      documentName(file.filename),
    );
    const result = await this.request<{ message_id?: number }>(
      'sendDocument',
      body,
    );
    return confirmedMessageId(result);
  }
  me(): Promise<TelegramUser> {
    return this.call('getMe');
  }
  updates(offset: number): Promise<TelegramUpdate[]> {
    return this.call('getUpdates', {
      offset,
      timeout: 25,
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    });
  }
  async send(
    chatId: string,
    text: string,
    markup?: unknown,
    threadId?: number,
  ): Promise<number | undefined> {
    // One outbox entry is one API request; longer replies are split before persistence.
    return this.rich.send({ chatId, threadId }, text, markup);
  }
  async editRich(
    chatId: string,
    messageId: number,
    text: string,
    markup?: unknown,
  ): Promise<void> {
    await this.rich.editGroupPreview({ chatId }, messageId, text, markup);
  }
  async answer(id: string, text: string): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: id,
      text: text.slice(0, 190),
    });
  }
  async typing(chatId: string): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action: 'typing' });
  }
  stop(): void {
    this.controller.abort();
  }
}
