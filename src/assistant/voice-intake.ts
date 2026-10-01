import type { AssistantConfig } from '../config/assistant-config.js';
import type {
  TelegramAssistantApi,
  TelegramUpdate,
} from '../channels/telegram-assistant-api.js';
import type { AssistantStore } from '../persistence/assistant-store.js';
import {
  AssistantVoiceStore,
  voiceReservedCost,
} from '../persistence/assistant-voice-store.js';
import {
  OpenAiWhisperVoice,
  VoiceError,
  type VoiceProvider,
} from '../providers/assistant-voice.js';
import { registerContextTurn } from './context.js';
import { enqueueReply } from './messages.js';
import { logger } from '../config/logger.js';

export class AssistantVoiceIntake {
  private readonly receipts: AssistantVoiceStore;
  private readonly active = new Map<
    number,
    {
      chat: string;
      user: string;
      controller: AbortController;
      promise: Promise<void>;
    }
  >();
  constructor(
    private readonly store: AssistantStore,
    private readonly config: AssistantConfig,
    private readonly api: TelegramAssistantApi,
    private readonly accept: (
      update: TelegramUpdate,
      transcript: string,
      contextVersion: number,
    ) => void,
    private readonly provider: VoiceProvider = new OpenAiWhisperVoice(
      config.voice,
    ),
  ) {
    this.receipts = new AssistantVoiceStore(store);
    // A prior upload may have been billed. Never repeat it automatically on restart.
    for (const receipt of this.receipts.active()) {
      this.receipts.finish(receipt.update_id, 'interrupted', receipt.cost_usd);
      if (store.contextVersion(receipt.chat_id) === receipt.context_version)
        enqueueReply(
          store,
          `voice:${receipt.update_id}:interrupted`,
          receipt.chat_id,
          'Распознавание голосового прервано перезапуском. Пришлите текст или отправьте голосовое заново.',
          {
            ownerId: receipt.user_id,
            threadId: receipt.thread_id ?? undefined,
          },
        );
    }
  }
  start(update: TelegramUpdate): string {
    const message = update.message!;
    const voice = message.voice!;
    const chat = String(message.chat.id),
      user = String(message.from!.id);
    const reply = (text: string) =>
      enqueueReply(this.store, `voice:${update.update_id}:notice`, chat, text, {
        ownerId: user,
        threadId: message.message_thread_id,
      });
    if (this.receipts.receipt(update.update_id)) return 'duplicate_voice';
    if (
      !this.config.voice.enabled ||
      !this.config.voice.apiKey ||
      this.config.voice.monthlyBudget <= 0 ||
      this.config.voice.usdPerMinute <= 0
    ) {
      reply('Голосовые пока не подключены. Пришлите текст.');
      return 'unsupported_voice';
    }
    if (message.forward_origin || message.is_automatic_forward) {
      reply(
        'Пересланное голосовое не выполняю от имени отправителя. Напишите свою задачу текстом.',
      );
      return 'rejected_forwarded_voice';
    }
    if (
      !Number.isFinite(voice.duration) ||
      voice.duration <= 0 ||
      voice.duration > this.config.voice.maxSeconds ||
      (voice.file_size !== undefined &&
        (!Number.isFinite(voice.file_size) ||
          voice.file_size < 1 ||
          voice.file_size > this.config.voice.maxBytes)) ||
      (voice.mime_type &&
        !['audio/ogg', 'audio/opus', 'application/ogg'].includes(
          voice.mime_type.toLowerCase().split(';')[0],
        ))
    ) {
      reply(
        `Нужно голосовое Telegram до 1 МиБ и ${this.config.voice.maxSeconds} секунд.`,
      );
      return 'rejected_voice';
    }
    if (
      this.active.size >= 2 ||
      [...this.active.values()].some(
        (run) => run.user === user || run.chat === chat,
      )
    ) {
      reply(
        'Голосовое уже обрабатывается. Подождите или отмените своё через /cancel_voice.',
      );
      return 'busy_voice';
    }
    const pending = this.store.db
      .query("SELECT COUNT(*) AS n FROM assistant_inbox WHERE status='pending'")
      .get() as { n: number };
    if (pending.n >= 100) {
      reply('Сейчас много задач. Попробуйте чуть позже.');
      return 'busy_voice';
    }
    if (
      this.store.dailyCount('user_id', user) >= this.config.dailyTasks ||
      this.store.dailyCount('chat_id', chat) >= this.config.dailyChatTasks
    ) {
      reply(
        'Лимит задач на сегодня исчерпан. Голосовое не отправлялось на распознавание.',
      );
      return 'limited_voice';
    }
    const contextVersion = this.store.contextVersion(chat);
    try {
      this.receipts.reserve(
        {
          update_id: update.update_id,
          chat_id: chat,
          user_id: user,
          thread_id: message.message_thread_id ?? null,
          context_version: contextVersion,
        },
        this.config,
      );
    } catch (error) {
      if (!(error instanceof VoiceError)) throw error;
      reply(error.message);
      return 'limited_voice';
    }
    const controller = new AbortController();
    const promise = this.process(update, contextVersion, controller)
      .catch(() => {
        logger.warn('Voice processing failed; reservation retained');
      })
      .finally(() => this.active.delete(update.update_id));
    this.active.set(update.update_id, { chat, user, controller, promise });
    return 'processing_voice';
  }
  private async process(
    update: TelegramUpdate,
    contextVersion: number,
    controller: AbortController,
  ): Promise<void> {
    const message = update.message!,
      chat = String(message.chat.id);
    const context = registerContextTurn(this.store, chat);
    const signal = AbortSignal.any([
      controller.signal,
      context.signal,
      AbortSignal.timeout(this.config.voice.timeoutMs),
    ]);
    let submitted = false;
    let cost = this.receipts.receipt(update.update_id)!.cost_usd;
    try {
      const bytes = await this.api.downloadDocument(
        message.voice!.file_id,
        this.config.voice.maxBytes,
        signal,
      );
      const prepared = await this.provider.prepare(bytes, signal);
      signal.throwIfAborted();
      if (
        !Number.isFinite(prepared.seconds) ||
        prepared.seconds <= 0 ||
        prepared.seconds > this.config.voice.maxSeconds ||
        !prepared.bytes.length ||
        prepared.bytes.length > 44 + this.config.voice.maxSeconds * 32000
      )
        throw new VoiceError('Голосовое превышает лимиты распознавания.');
      this.receipts.submit(update.update_id, this.config);
      submitted = true;
      const transcript = await this.provider.transcribe(prepared, signal);
      signal.throwIfAborted();
      if (this.store.contextVersion(chat) !== contextVersion)
        throw new VoiceError('Контекст очищен.');
      cost = voiceReservedCost(
        prepared.seconds,
        this.config.voice.usdPerMinute,
      );
      // No async gap between final cancellation check and enqueue.
      this.accept(update, transcript, contextVersion);
      this.receipts.finish(update.update_id, 'completed', cost);
    } catch (error) {
      // Keep the full reservation after an ambiguous paid upload, including cancellation.
      this.receipts.finish(
        update.update_id,
        signal.aborted ? 'cancelled' : 'failed',
        submitted ? cost : 0,
      );
      if (
        !controller.signal.aborted &&
        !context.signal.aborted &&
        this.store.contextVersion(chat) === contextVersion
      )
        enqueueReply(
          this.store,
          `voice:${update.update_id}:error`,
          chat,
          error instanceof VoiceError
            ? error.message
            : 'Распознавание прервано или недоступно. Пришлите текст.',
          {
            ownerId: String(message.from!.id),
            threadId: message.message_thread_id,
          },
        );
    } finally {
      context.release();
    }
  }
  cancel(chat: string, user: string): number {
    let count = 0;
    for (const run of this.active.values())
      if (run.chat === chat && run.user === user) {
        run.controller.abort();
        count++;
      }
    return count;
  }
  async stop(): Promise<void> {
    for (const run of this.active.values()) run.controller.abort();
    await Promise.allSettled(
      [...this.active.values()].map((run) => run.promise),
    );
  }
  async idle(): Promise<void> {
    await Promise.allSettled(
      [...this.active.values()].map((run) => run.promise),
    );
  }
}
