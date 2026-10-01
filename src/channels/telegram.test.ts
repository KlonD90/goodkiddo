import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../config/env.js', () => ({
  getEnv: vi.fn(() => undefined),
}));

vi.mock('../config/config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../config/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { TelegramChannel, type TelegramChannelOpts } from './telegram.js';

function createTestOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:12345': {
        name: 'Telegram test',
        folder: 'telegram_test',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function telegramJsonResponse(result: unknown) {
  return {
    ok: true,
    json: async () => ({ ok: true, result }),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsync(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

function installFetchMock(mock: ReturnType<typeof vi.fn>): void {
  globalThis.fetch = mock as unknown as typeof globalThis.fetch;
}

describe('TelegramChannel', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('connects, polls updates, and normalizes group messages', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('telegram-token', opts);
    const secondPoll = deferred<ReturnType<typeof telegramJsonResponse>>();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        telegramJsonResponse({
          id: 777,
          username: 'andy_bot',
        }),
      )
      .mockResolvedValueOnce(
        telegramJsonResponse([
          {
            update_id: 10,
            message: {
              message_id: 99,
              date: 1710000000,
              text: '@andy_bot check status',
              from: {
                id: 42,
                first_name: 'Alice',
              },
              chat: {
                id: 12345,
                type: 'group',
                title: 'Ops Room',
              },
            },
          },
        ]),
      )
      .mockImplementationOnce(() => secondPoll.promise);

    installFetchMock(fetchMock);

    await channel.connect();
    await flushAsync();

    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'tg:12345',
      '2024-03-09T16:00:00.000Z',
      'Ops Room',
      'telegram',
      true,
    );

    expect(opts.onMessage).toHaveBeenCalledWith(
      'tg:12345',
      expect.objectContaining({
        id: 'tg:99',
        chat_jid: 'tg:12345',
        sender: '42',
        sender_name: 'Alice',
        content: '@Andy check status',
        is_from_me: false,
        is_bot_message: false,
      }),
    );
    expect(channel.isConnected()).toBe(true);
    expect(channel.ownsJid('tg:12345')).toBe(true);

    const disconnectPromise = channel.disconnect();
    secondPoll.resolve(telegramJsonResponse([]));
    await disconnectPromise;

    expect(channel.isConnected()).toBe(false);
    expect(
      channel.isOwnMessage({
        id: 'x',
        chat_jid: 'tg:12345',
        sender: '777',
        sender_name: 'bot',
        content: 'hello',
        timestamp: '2024-01-01T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('ignores messages sent by the connected telegram bot', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('telegram-token', opts);
    const secondPoll = deferred<ReturnType<typeof telegramJsonResponse>>();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        telegramJsonResponse({
          id: 777,
          username: 'andy_bot',
        }),
      )
      .mockResolvedValueOnce(
        telegramJsonResponse([
          {
            update_id: 12,
            message: {
              message_id: 101,
              date: 1710000002,
              text: 'self message',
              from: {
                id: 777,
                is_bot: true,
                username: 'andy_bot',
              },
              chat: {
                id: 12345,
                type: 'group',
                title: 'Ops Room',
              },
            },
          },
        ]),
      )
      .mockImplementationOnce(() => secondPoll.promise);

    installFetchMock(fetchMock);

    await channel.connect();
    await Promise.resolve();

    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(opts.onChatMetadata).not.toHaveBeenCalled();

    const disconnectPromise = channel.disconnect();
    secondPoll.resolve(telegramJsonResponse([]));
    await disconnectPromise;
  });

  it('splits long outbound messages into multiple Telegram sendMessage calls', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('telegram-token', opts);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(telegramJsonResponse({ message_id: 1 }))
      .mockResolvedValueOnce(telegramJsonResponse({ message_id: 2 }));

    installFetchMock(fetchMock);

    const longText = `${'a'.repeat(3900)}\n${'b'.repeat(300)}`;
    await channel.sendMessage('tg:12345', longText);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.telegram.org/bottelegram-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('sendAndTrack returns the final Telegram message id', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('telegram-token', opts);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(telegramJsonResponse({ message_id: 10 }))
      .mockResolvedValueOnce(telegramJsonResponse({ message_id: 11 }));

    installFetchMock(fetchMock);

    const tracked = await channel.sendAndTrack(
      'tg:12345',
      `${'a'.repeat(3900)}\n${'b'.repeat(300)}`,
    );

    expect(tracked).toBe('11');
  });

  it('editMessage only edits the first chunk of a long message', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('telegram-token', opts);
    const fetchMock = vi.fn().mockResolvedValue(telegramJsonResponse(true));

    installFetchMock(fetchMock);

    await channel.editMessage(
      'tg:12345',
      '55',
      `${'a'.repeat(3900)}\n${'b'.repeat(300)}`,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bottelegram-token/editMessageText',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"message_id":55'),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      text: string;
    };
    expect(body.text.length).toBeLessThanOrEqual(4000);
  });

  it('setTyping sends a Telegram typing action when enabled', async () => {
    const opts = createTestOpts();
    const channel = new TelegramChannel('telegram-token', opts);
    const fetchMock = vi.fn().mockResolvedValue(telegramJsonResponse(true));

    installFetchMock(fetchMock);

    await channel.setTyping('tg:12345', true);
    await channel.setTyping('tg:12345', false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bottelegram-token/sendChatAction',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"action":"typing"'),
      }),
    );
  });
});
