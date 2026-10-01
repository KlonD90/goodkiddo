import { TelegramApiError } from './telegram-assistant-api.js';
import {
  richMarkdown,
  unsupportedRichMethod,
  type TelegramCaller,
  type RichTarget,
} from './telegram-rich-delivery.js';

interface StreamOptions extends RichTarget {
  chatType: 'private' | 'group' | 'supergroup';
  draftId: number;
  now?: () => number;
}
// One active turn per chat owns this object. Snapshots coalesce; network requests never overlap.
export class TelegramDraftStream {
  private latest = '';
  private sent = '';
  private nextAt = 0;
  private active: Promise<void> | null = null;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly api: TelegramCaller,
    private readonly options: StreamOptions,
  ) {
    if (!Number.isSafeInteger(options.draftId) || options.draftId === 0)
      throw new Error('Draft ID must be non-zero');
  }
  readonly update = (text: string): void => {
    if (this.closed || this.options.chatType !== 'private') return;
    this.latest = [...text].slice(0, 30_000).join('');
    this.schedule();
  };
  private schedule(): void {
    if (
      this.closed ||
      this.active ||
      this.timer ||
      !this.latest ||
      this.latest === this.sent
    )
      return;
    const now = this.options.now?.() ?? Date.now();
    if (now < this.nextAt) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.schedule();
      }, this.nextAt - now);
      this.timer.unref?.();
      return;
    }
    this.active = this.flush().finally(() => {
      this.active = null;
      this.schedule();
    });
  }
  private async flush(): Promise<void> {
    const text = this.latest;
    this.nextAt = (this.options.now?.() ?? Date.now()) + 1000;
    try {
      await this.api.call('sendRichMessageDraft', {
        chat_id: Number(this.options.chatId),
        message_thread_id: this.options.threadId,
        draft_id: this.options.draftId,
        rich_message: richMarkdown(text),
      });
      this.sent = text;
    } catch (error) {
      if (error instanceof TelegramApiError && error.code === 429) {
        this.nextAt =
          (this.options.now?.() ?? Date.now()) +
          Math.max(1000, error.retryAfter * 1000);
      } else {
        // Preview failure must not fail a user turn. Stop retries on uncertain/unsupported replies.
        this.closed = true;
        if (unsupportedRichMethod(error)) this.sent = text;
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
    // The durable outbox sends the complete rich reply. Drafts expire automatically.
  }
}
