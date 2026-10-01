import type { AssistantStore } from '../persistence/assistant-store.js';
import {
  ensureTextDeliverySchema,
  type TextTarget,
} from '../persistence/assistant-text-outbox.js';
import {
  TelegramApiError,
  type TelegramAssistantApi,
} from './telegram-assistant-api.js';
import { TelegramDraftStream } from './telegram-draft-stream.js';
import { TelegramRichDelivery } from './telegram-rich-delivery.js';
import { splitTelegramMarkdown } from './telegram-markdown-chunks.js';

interface Options {
  taskId: string;
  chatId: string;
  chatType: 'private' | 'group' | 'supergroup';
  draftId: number;
  threadId?: number;
}
interface PreviewState {
  message_id: number | null;
  status: string;
}
export class TelegramTurnPreview {
  private readonly drafts: TelegramDraftStream;
  private readonly rich: TelegramRichDelivery;
  private latest = '';
  private sent = '';
  private nextAt = 0;
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private disabled = false;
  constructor(
    private readonly store: AssistantStore,
    api: TelegramAssistantApi,
    private readonly options: Options,
  ) {
    ensureTextDeliverySchema(store);
    this.rich = new TelegramRichDelivery(api);
    this.drafts = new TelegramDraftStream(api, options);
  }
  readonly update = (text: string): void => {
    if (this.closed) return;
    if (!text) {
      this.latest = '';
      return;
    }
    const first = splitTelegramMarkdown(text)[0];
    if (this.options.chatType === 'private') {
      this.drafts.update(first);
      return;
    }
    this.latest = first;
    this.schedule();
  };
  private state(): PreviewState | null {
    return this.store.db
      .query(
        'SELECT message_id,status FROM assistant_reply_previews WHERE run_id=? AND chat_id=?',
      )
      .get(this.options.taskId, this.options.chatId) as PreviewState | null;
  }
  private schedule(): void {
    if (
      this.closed ||
      this.disabled ||
      this.active ||
      this.timer ||
      !this.latest ||
      this.latest === this.sent
    )
      return;
    if (Date.now() < this.nextAt) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.schedule();
      }, this.nextAt - Date.now());
      this.timer.unref?.();
      return;
    }
    this.active = this.flush().finally(() => {
      this.active = null;
      this.schedule();
    });
  }
  private async flush(): Promise<void> {
    const target = {
      chatId: this.options.chatId,
      threadId: this.options.threadId,
    };
    const snapshot = this.latest;
    this.nextAt = Date.now() + 3200;
    let state = this.state();
    try {
      if (!state) {
        this.store.db
          .query(
            'INSERT INTO assistant_reply_previews(run_id,chat_id,thread_id) VALUES (?,?,?)',
          )
          .run(
            this.options.taskId,
            this.options.chatId,
            this.options.threadId ?? null,
          );
        // Creation always uses a placeholder. An uncertain create cannot duplicate a final answer.
        const messageId = await this.rich.beginGroupPreview(
          target,
          'Готовлю ответ…',
        );
        this.store.db
          .query(
            "UPDATE assistant_reply_previews SET message_id=?,status='active' WHERE run_id=?",
          )
          .run(messageId, this.options.taskId);
        state = this.state();
        return;
      }
      if (state.status !== 'active' || !state.message_id) {
        this.disabled = true;
        return;
      }
      await this.rich.editGroupPreview(target, state.message_id, snapshot);
      this.sent = snapshot;
    } catch (error) {
      if (error instanceof TelegramApiError && error.code === 429) {
        this.nextAt = Date.now() + Math.max(3200, error.retryAfter * 1000);
        if (!state)
          this.store.db
            .query('DELETE FROM assistant_reply_previews WHERE run_id=?')
            .run(this.options.taskId);
      } else {
        this.disabled = true;
        if (!state)
          this.store.db
            .query(
              "UPDATE assistant_reply_previews SET status='uncertain' WHERE run_id=?",
            )
            .run(this.options.taskId);
      }
    }
  }
  async close(): Promise<TextTarget> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.all([this.active, this.drafts.close()]);
    const state = this.state();
    return {
      threadId: this.options.threadId,
      messageId: state?.message_id ?? undefined,
    };
  }
}
