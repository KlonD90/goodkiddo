import { test, expect } from 'bun:test';
import { AssistantStore } from '../src/persistence/assistant-store.ts';
import { AssistantFiles } from '../src/persistence/assistant-files.ts';
import { AssistantAnalytics } from '../src/integrations/assistant-analytics.ts';
import { AssistantIngress } from '../src/assistant/ingress.ts';
import { AssistantWorker } from '../src/assistant/worker.ts';
import { deliverMessages } from '../src/assistant/delivery.ts';
import { publicArtifactHandler } from '../src/server/assistant-file-links.ts';
import type { AssistantLlm } from '../src/providers/assistant-llm.ts';
import type { TelegramAssistantApi } from '../src/channels/telegram-assistant-api.ts';
import { fileConfig } from './fixtures/file-assistant-config.ts';
import { analyticsProperties } from '../src/integrations/assistant-analytics-policy.ts';

function call(name: string, args: Record<string, unknown>, id: string) {
  return {
    id,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

test('Telegram ingress → existing agent → static publication → durable same-chat final contains the working URL', async () => {
  const config = fileConfig();
  config.fileShares.enabled = true;
  config.miniPages.enabled = true;
  const store = new AssistantStore(':memory:');
  const analytics = new AssistantAnalytics(config, store);
  const sent: { chat: string; text: string }[] = [];
  const api = {
    typing: async () => {},
    send: async (chat: string, text: string) => {
      sent.push({ chat, text });
    },
  } as unknown as TelegramAssistantApi;
  const foreign = 'FOREIGN_CHAT_PRIVATE';
  new AssistantFiles(store.db).write(
    '2',
    '/trip/index.html',
    new TextEncoder().encode(foreign),
  );
  store.memory.write('2', '2', 'secret', 'FOREIGN_MEMORY_PRIVATE', 'fact');
  let round = 0;
  let link = '';
  let browserLink = '';
  const llm: AssistantLlm = {
    complete: async (messages, tools) => {
      round++;
      expect(tools.map((tool) => tool.function.name)).toContain('publish_page');
      expect(tools.map((tool) => tool.function.name)).toContain('memory_write');
      expect(tools.map((tool) => tool.function.name)).toContain('research');
      expect(JSON.stringify(messages)).not.toContain('FOREIGN_MEMORY_PRIVATE');
      if (round === 1)
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              call(
                'write_file',
                {
                  file_path: '/trip/index.html',
                  content:
                    '<!doctype html><html lang="ru"><link rel="stylesheet" href="style.css"><h1>План поездки</h1><p>Суббота: прогулка.</p></html>',
                },
                'write',
              ),
              call(
                'write_file',
                {
                  file_path: '/trip/style.css',
                  content:
                    'body{font:18px sans-serif;max-width:60rem;margin:auto}h1{color:#123456}',
                },
                'style',
              ),
            ],
          },
        };
      if (round === 2)
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              call(
                'publish_page',
                {
                  file_path: '/trip/index.html',
                  title: 'План поездки',
                  asset_paths: ['/trip/style.css'],
                },
                'publish',
              ),
              call('grant_fs_access', { scope_path: '/trip/' }, 'browser'),
            ],
          },
        };
      const result = JSON.parse(
        messages.find((m) => m.role === 'tool' && m.tool_call_id === 'publish')!
          .content!,
      ) as { url: string; expires_at: string; id: string };
      link = result.url;
      const browser = JSON.parse(
        messages.find((m) => m.role === 'tool' && m.tool_call_id === 'browser')!
          .content!,
      ) as { url: string; html_previews: { url: string }[] };
      browserLink = browser.url;
      expect(browserLink).toStartWith('https://app.whosagoodkiddo.me/fs/');
      expect(
        await publicArtifactHandler(
          config,
          store,
        )(new Request(browserLink)).text(),
      ).toContain('index.html');
      expect(
        await publicArtifactHandler(
          config,
          store,
        )(new Request(browser.html_previews[0].url)).text(),
      ).toContain('<h1>План поездки</h1>');
      expect(link).toStartWith('https://whosagoodkiddo.me/p/');
      expect(
        publicArtifactHandler(config, store)(new Request(link)).status,
      ).toBe(200);
      await deliverMessages(store, api, analytics);
      expect(sent).toEqual([]);
      return {
        message: {
          role: 'assistant',
          content: `[План поездки](${link})\n[Файловый браузер](${browserLink})\nДоступна до ${result.expires_at}; любой обладатель ссылки может открыть её. ID: ${result.id}.`,
        },
      };
    },
  };
  const ingress = new AssistantIngress(store, config, analytics, api, {
    id: 99,
    username: 'goodkiddo_bot',
  });
  const worker = new AssistantWorker(config, store, analytics, llm, api);
  try {
    expect(
      await ingress.handle({
        update_id: 801,
        message: {
          message_id: 1,
          date: 1700000000,
          from: { id: 1, first_name: 'Synthetic' },
          chat: { id: 1, type: 'private' },
          text: 'Создай мини-страницу с планом поездки и дай ссылку на неё и браузерную ссылку на папку /trip/',
        },
      }),
    ).toBe('enqueued_message');
    worker.wake();
    for (
      let i = 0;
      i < 200 &&
      store.db
        .query("SELECT id FROM assistant_inbox WHERE status!='done'")
        .get();
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(
      store.db
        .query("SELECT id FROM assistant_inbox WHERE status!='done'")
        .all(),
    ).toEqual([]);
    expect(round).toBe(3);
    expect(sent).toEqual([]);
    expect(
      store.db.query('SELECT * FROM assistant_mini_pages').all(),
    ).toHaveLength(2);
    expect(
      store.db
        .query(
          "SELECT key FROM assistant_state WHERE key LIKE 'delivery_hold:%'",
        )
        .all(),
    ).toEqual([]);
    await deliverMessages(store, api, analytics);
    expect(sent).toHaveLength(1);
    expect(sent[0].chat).toBe('1');
    expect(sent[0].text).toContain(link);
    expect(sent[0].text).toContain(browserLink);
    for (const tool_name of ['publish_page', 'list_pages', 'revoke_page'])
      expect(
        analyticsProperties({
          tool_name,
          url: link,
          title: 'PRIVATE_TITLE',
          html: 'PRIVATE_HTML',
        }),
      ).toEqual({ tool_name });
    expect(JSON.stringify(sent)).not.toContain(foreign);
    const response = publicArtifactHandler(config, store)(new Request(link));
    const html = await response.text();
    expect(html).toContain('<h1>План поездки</h1>');
    expect(html).not.toContain(foreign);
    expect(html).not.toContain('FOREIGN_MEMORY_PRIVATE');
    expect(
      store.db
        .query('SELECT llm_calls,cost_usd,status FROM assistant_runs')
        .get(),
    ).toMatchObject({ llm_calls: 3, cost_usd: 0, status: 'success' });
    expect(
      store.db.query('SELECT * FROM assistant_file_grants').all(),
    ).toHaveLength(1);
    // A group conversation without addressing the bot stays outside its context.
    expect(
      await ingress.handle({
        update_id: 802,
        message: {
          message_id: 2,
          date: 1700000000,
          from: { id: 2, first_name: 'Other' },
          chat: { id: -3, type: 'supergroup' },
          text: 'Создай мини-страницу из чужой беседы',
        },
      }),
    ).toBe('ignored_unaddressed');
    expect(store.history('-3')).toEqual([]);
  } finally {
    await worker.stop();
    await analytics.shutdown();
    store.close();
  }
});
