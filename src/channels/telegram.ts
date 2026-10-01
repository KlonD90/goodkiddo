import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config/config.js';
import { getEnv } from '../config/env.js';
import { logger } from '../config/logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../shared/types.js';

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  chat: TelegramChat;
  reply_to_message?: {
    from?: TelegramUser;
    text?: string;
    caption?: string;
  };
  photo?: Array<{ file_id: string }>;
  voice?: { file_id: string; duration?: number };
  audio?: { file_id: string; duration?: number; title?: string };
  document?: { file_id: string; file_name?: string };
  video?: { file_id: string; duration?: number };
  sticker?: { emoji?: string };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTelegramUserName(user?: TelegramUser): string {
  if (!user) return 'Telegram user';
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return fullName || user.username || String(user.id);
}

function getTelegramChatName(chat: TelegramChat, senderName: string): string {
  const fullName = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
  return chat.title || fullName || chat.username || senderName;
}

function isTelegramGroup(chat: TelegramChat): boolean {
  return chat.type === 'group' || chat.type === 'supergroup';
}

function summarizeTelegramAttachments(message: TelegramMessage): string[] {
  const parts: string[] = [];

  if (message.photo?.length) parts.push('[Image]');
  if (message.voice) parts.push('[Voice message]');
  if (message.audio) parts.push(`[Audio: ${message.audio.title || 'audio'}]`);
  if (message.video) parts.push('[Video]');
  if (message.document) {
    parts.push(`[File: ${message.document.file_name || 'document'}]`);
  }
  if (message.sticker) {
    parts.push(
      message.sticker.emoji
        ? `[Sticker: ${message.sticker.emoji}]`
        : '[Sticker]',
    );
  }

  return parts;
}

function extractMessageText(message: TelegramMessage): string {
  const parts: string[] = [];
  const text = message.text?.trim() || message.caption?.trim() || '';
  if (text) {
    parts.push(text);
  }
  parts.push(...summarizeTelegramAttachments(message));

  if (parts.length === 0) {
    return '[Unsupported Telegram message]';
  }

  return parts.join('\n');
}

function buildReplyPrefix(message: TelegramMessage): string {
  const reply = message.reply_to_message;
  if (!reply) return '';

  const replySender = getTelegramUserName(reply.from);
  const replyText = (reply.text || reply.caption || '').trim();
  const trimmed =
    replyText.length > 120 ? `${replyText.slice(0, 117)}...` : replyText;

  return trimmed
    ? `[Reply to ${replySender}: ${trimmed}]\n`
    : `[Reply to ${replySender}]\n`;
}

function normalizeTelegramMentions(
  content: string,
  botUsername: string | undefined,
): string {
  const username = botUsername?.trim();
  if (!username) return content;

  const mentionRegex = new RegExp(`@${username}\\b`, 'gi');
  if (!mentionRegex.test(content)) {
    return content;
  }

  const stripped = content.replace(mentionRegex, '').trim();
  if (!stripped) {
    return `@${ASSISTANT_NAME}`;
  }
  if (TRIGGER_PATTERN.test(stripped)) {
    return stripped;
  }
  return `@${ASSISTANT_NAME} ${stripped}`;
}

function chunkTelegramText(text: string, maxLength = 4000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < maxLength * 0.6) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt < maxLength * 0.5) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private readonly opts: TelegramChannelOpts;
  private readonly apiBaseUrl: string;
  private connected = false;
  private stopRequested = false;
  private pollLoop: Promise<void> | null = null;
  private nextUpdateId = 0;
  private botUserId?: number;
  private botUsername?: string;

  constructor(
    private readonly botToken: string,
    opts: TelegramChannelOpts,
  ) {
    this.opts = opts;
    this.apiBaseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  private async apiCall<T>(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${this.apiBaseUrl}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      throw new Error(`Telegram API ${method} failed: ${res.status}`);
    }

    const payload = (await res.json()) as TelegramApiResponse<T>;
    if (!payload.ok) {
      throw new Error(
        `Telegram API ${method} error: ${payload.description || 'unknown error'}`,
      );
    }

    return payload.result;
  }

  async connect(): Promise<void> {
    const me = await this.apiCall<TelegramUser>('getMe');
    this.botUserId = me.id;
    this.botUsername = me.username;
    this.stopRequested = false;
    this.connected = true;
    this.pollLoop = this.startPolling();

    logger.info(
      {
        channel: this.name,
        botUserId: this.botUserId,
        botUsername: this.botUsername,
      },
      'Telegram channel connected',
    );
  }

  private async startPolling(): Promise<void> {
    while (!this.stopRequested) {
      try {
        const updates = await this.apiCall<TelegramUpdate[]>('getUpdates', {
          offset: this.nextUpdateId,
          timeout: 30,
          allowed_updates: ['message', 'edited_message'],
        });

        for (const update of updates) {
          this.nextUpdateId = Math.max(this.nextUpdateId, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (err) {
        logger.error({ err, channel: this.name }, 'Telegram polling failed');
        await sleep(2000);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message || update.edited_message;
    if (!message || message.chat.type === 'channel') return;

    const sender = message.from;
    if (!sender) return;
    if (sender.is_bot && sender.id === this.botUserId) return;

    const chatJid = `tg:${message.chat.id}`;
    const senderName = getTelegramUserName(sender);
    const timestamp = new Date(message.date * 1000).toISOString();
    const isGroup = isTelegramGroup(message.chat);
    const chatName = getTelegramChatName(message.chat, senderName);

    let content = extractMessageText(message);
    content = `${buildReplyPrefix(message)}${content}`.trim();
    content = normalizeTelegramMentions(content, this.botUsername);

    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);
    this.opts.onMessage(chatJid, {
      id: `tg:${message.message_id}`,
      chat_jid: chatJid,
      sender: String(sender.id),
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: !!sender.is_bot,
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  isOwnMessage(msg: NewMessage): boolean {
    return !!this.botUserId && msg.sender === String(this.botUserId);
  }

  async disconnect(): Promise<void> {
    this.stopRequested = true;
    const activePollLoop = this.pollLoop;
    this.pollLoop = null;
    this.connected = false;
    if (activePollLoop) {
      await activePollLoop;
    }
  }

  private async sendChunk(
    jid: string,
    text: string,
  ): Promise<{ message_id: number }> {
    const chatId = jid.replace(/^tg:/, '');
    return this.apiCall<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    for (const chunk of chunkTelegramText(text)) {
      await this.sendChunk(jid, chunk);
    }
  }

  async sendAndTrack(jid: string, text: string): Promise<string | null> {
    let lastMessageId: string | null = null;
    for (const chunk of chunkTelegramText(text)) {
      const response = await this.sendChunk(jid, chunk);
      lastMessageId = String(response.message_id);
    }
    return lastMessageId;
  }

  async editMessage(
    jid: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    const chatId = jid.replace(/^tg:/, '');
    const [firstChunk] = chunkTelegramText(text);
    await this.apiCall('editMessageText', {
      chat_id: chatId,
      message_id: Number(messageId),
      text: firstChunk,
      disable_web_page_preview: true,
    });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;

    const chatId = jid.replace(/^tg:/, '');
    try {
      await this.apiCall('sendChatAction', {
        chat_id: chatId,
        action: 'typing',
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const token = getEnv('TELEGRAM_BOT_TOKEN') || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
