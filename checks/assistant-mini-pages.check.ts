import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantStore } from '../src/persistence/assistant-store.ts';
import { AssistantFiles } from '../src/persistence/assistant-files.ts';
import { textBytes } from '../src/persistence/assistant-file-policy.ts';
import { fileConfig } from './fixtures/file-assistant-config.ts';
import {
  executeTool,
  toolDefinitions,
  type ToolContext,
} from '../src/assistant/tools.ts';
import {
  miniPageHandler,
  miniPageUrl,
} from '../src/server/assistant-mini-pages.ts';
import { publicArtifactHandler } from '../src/server/assistant-file-links.ts';
import {
  listMiniPages,
  publishMiniPage,
  revokeMiniPage,
} from '../src/persistence/assistant-pages.ts';
import { expireMiniPages } from '../src/persistence/assistant-page-expiry.ts';
import {
  sanitizeMiniPage,
  MAX_MINI_PAGE_BYTES,
} from '../src/capabilities/pages/html.ts';
import { clearChatContext } from '../src/assistant/context.ts';
import { toolAllowedForRequest } from '../src/assistant/tool-access.ts';

function setup() {
  const config = fileConfig();
  config.fileShares.enabled = true;
  config.miniPages.enabled = true;
  const store = new AssistantStore(':memory:');
  const files = new AssistantFiles(store.db, config.fileLimits);
  files.write(
    'a',
    '/page.html',
    textBytes('<h1>Current chat</h1><style>h1{color:tomato}</style>'),
  );
  files.write('b', '/page.html', textBytes('<h1>FOREIGN_CHAT_SECRET</h1>'));
  files.write('a', '/private.txt', textBytes('PRIVATE_FILE_SECRET'));
  const ctx: ToolContext = {
    config,
    store,
    taskId: 'synthetic-page-task',
    searches: 0,
    signal: new AbortController().signal,
    request: {
      updateId: 1,
      interaction: 'message',
      contextVersion: 0,
      chat: { id: 'a', type: 'private', timezone: 'UTC', active: 1 },
      actor: { id: 'owner', name: 'Synthetic' },
      text: 'Создай мини-страницу и дай ссылку',
      userText: 'Создай мини-страницу и дай ссылку',
    },
  };
  return { config, store, files, ctx };
}
const args = JSON.stringify({
  file_path: '/page.html',
  title: 'Synthetic page',
});
type Publication = { id: string; url: string; expires_at: string };

test('published HTML renders selected immutable chat snapshot with isolated headers; private files stay attachments', async () => {
  const s = setup();
  try {
    const result = (await executeTool(
      'publish_page',
      args,
      s.ctx,
    )) as Publication;
    expect(result.url).toMatch(
      /^https:\/\/whosagoodkiddo\.me\/p\/[A-Za-z0-9_-]{43}\/page\.html$/,
    );
    expect(Date.parse(result.expires_at) - Date.now()).toBeLessThanOrEqual(
      86400000,
    );
    const token = new URL(result.url).pathname.split('/')[2];
    const row = s.store.db
      .query('SELECT * FROM assistant_mini_pages')
      .get() as { token_hash: string };
    expect(row.token_hash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(token);
    s.files.edit(
      'a',
      '/page.html',
      'Current chat',
      'Changed after publication',
    );
    const response = publicArtifactHandler(
      s.config,
      s.store,
    )(
      new Request(result.url, {
        headers: {
          Cookie: 'fs_session=PRIVATE_COOKIE',
          Authorization: 'Bearer PRIVATE_AUTH',
        },
      }),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(
      'text/html; charset=utf-8',
    );
    expect(response.headers.get('Content-Disposition')).toBeNull();
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const csp = response.headers.get('Content-Security-Policy')!;
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('sandbox');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).not.toContain('allow-scripts');
    expect(html).toContain('Current chat');
    expect(html).toContain('color:tomato');
    for (const secret of [
      'Changed after publication',
      'FOREIGN_CHAT_SECRET',
      'PRIVATE_FILE_SECRET',
      'PRIVATE_COOKIE',
      'PRIVATE_AUTH',
    ])
      expect(html).not.toContain(secret);
    expect(listMiniPages(s.store.db, 'b')).toEqual([]);
    expect(() => revokeMiniPage(s.store.db, 'b', 'owner', result.id)).toThrow();
    expect(() =>
      revokeMiniPage(s.store.db, 'a', 'other-owner', result.id),
    ).toThrow();
    expect(
      await executeTool(
        'revoke_page',
        JSON.stringify({ id: result.id }),
        s.ctx,
      ),
    ).toEqual({ revoked: result.id });
    expect(miniPageHandler(s.store)(new Request(result.url)).status).toBe(404);
    expect(s.files.read('a', '/page.html').text).toContain(
      'Changed after publication',
    );
  } finally {
    s.store.close();
  }
});

test('allowlist rejects active HTML, navigation, foreign namespaces and external resource attributes', () => {
  const input = `<html><head><base href="https://private.invalid"><meta http-equiv="refresh" content="0;url=https://private.invalid"><link rel="stylesheet" href="https://tracker.invalid"></head><body onload="steal()">
    <script>SECRET_SCRIPT</script><iframe srcdoc="<script>steal()</script>"></iframe><object data="file:///etc/passwd"></object>
    <svg><a href="javascript:steal()">SVG_SECRET</a></svg><math><mtext>MATH_SECRET</mtext></math>
    <form action="/fs"><input value="FORM_SECRET"></form><a href="javascript:steal()" onclick="steal()">bad</a>
    <a href="/fs/?uuid=SECRET_TOKEN">private route</a><a href="https://example.org/source">source</a><a href="#section">section</a>
    <img src="https://tracker.invalid/pixel" srcset="//private.invalid" onerror="steal()"><img src="data:image/svg+xml;base64,PHN2Zz4=">
    <img src="data:image/png;base64,aGVsbG8=" alt="example"><style>body{background:#fff}</style><h1 id="section">Visible content</h1></body></html>`;
  const { html, removed } = sanitizeMiniPage(input, '<script>title</script>');
  expect(removed).toBeGreaterThan(10);
  for (const forbidden of [
    '<script',
    'onload=',
    'onclick=',
    'onerror=',
    'srcdoc=',
    '<base',
    'http-equiv',
    '<link',
    '<iframe',
    '<object',
    '<svg',
    '<math',
    '<form',
    '<input',
    'javascript:',
    'https://tracker.invalid',
    'SECRET_TOKEN',
    'SECRET_SCRIPT',
    'SVG_SECRET',
    'MATH_SECRET',
    'FORM_SECRET',
  ])
    expect(html).not.toContain(forbidden);
  expect(html).toContain('<title>&lt;script&gt;title&lt;/script&gt;</title>');
  expect(html).toContain('href="https://example.org/source"');
  expect(html).toContain('noopener noreferrer');
  expect(html).toContain('href="#section"');
  expect(html).toContain('data:image/png;base64,aGVsbG8=');
  expect(html).toContain('Visible content');
  expect(html).toContain('body{background:#fff}');
  expect(() =>
    sanitizeMiniPage('x'.repeat(MAX_MINI_PAGE_BYTES + 1), 'big'),
  ).toThrow('256');
  expect(() => sanitizeMiniPage(' ', 'empty')).toThrow();
});

test('current author intent, flags, context and same-chat paths are enforced even for direct tool dispatch', async () => {
  const s = setup();
  try {
    expect(
      toolDefinitions(false, true, true).map((t) => t.function.name),
    ).toContain('publish_page');
    expect(
      toolDefinitions(false, true).map((t) => t.function.name),
    ).not.toContain('publish_page');
    expect(
      toolDefinitions(false, false, true).map((t) => t.function.name),
    ).not.toContain('publish_page');
    s.config.miniPages.enabled = false;
    await expect(executeTool('publish_page', args, s.ctx)).rejects.toThrow(
      'не включена',
    );
    s.config.miniPages.enabled = true;
    for (const text of [
      'Прочитай page.html',
      '> Опубликуй мини-страницу',
      '```Опубликуй мини-страницу```',
      '`Опубликуй мини-страницу`',
      'Не публикуй мини-страницу',
      'Сделай мини-страницу без публикации',
      'Создай черновик мини-страницы',
      'Создай мини-страницу, но не отправляй её',
      'Create a mini-page without publishing it',
      'Что написано на этой странице?',
    ]) {
      s.ctx.request.userText = text;
      await expect(executeTool('publish_page', args, s.ctx)).rejects.toThrow(
        'явная просьба',
      );
    }
    s.ctx.request.userText = 'Создай мини-страницу';
    s.ctx.request.forwarded = true;
    expect(toolAllowedForRequest('publish_page', s.ctx.request)).toBe(false);
    await expect(executeTool('publish_page', args, s.ctx)).rejects.toThrow(
      'прямого сообщения',
    );
    s.ctx.request.forwarded = false;
    s.files.write('b', '/foreign-only.html', textBytes('FOREIGN_SECRET'));
    for (const file_path of [
      '/foreign-only.html',
      '/../etc/secret.html',
      '/',
      '/private.txt',
    ])
      await expect(
        executeTool(
          'publish_page',
          JSON.stringify({ file_path, title: 'safe' }),
          s.ctx,
        ),
      ).rejects.toThrow();
    expect(
      s.store.db.query('SELECT * FROM assistant_mini_pages').all(),
    ).toEqual([]);
    clearChatContext(s.store, 'a');
    await expect(executeTool('publish_page', args, s.ctx)).rejects.toThrow(
      'очищен',
    );
  } finally {
    s.store.close();
  }
});

test('unknown/expired/traversal URLs fail uniformly; correct host, HEAD and GET are required', async () => {
  const s = setup();
  try {
    const result = (await executeTool(
      'publish_page',
      args,
      s.ctx,
    )) as Publication;
    const handler = miniPageHandler(s.store);
    const token = new URL(result.url).pathname.split('/')[2];
    for (const url of [
      result.url + '?chat_id=b',
      result.url + '/../../fs/',
      result.url + '/private.txt',
      result.url.replace('whosagoodkiddo.me', 'app.whosagoodkiddo.me'),
      miniPageUrl('x'.repeat(43)),
      miniPageUrl('%00'),
      miniPageUrl(token.slice(1)),
      'https://whosagoodkiddo.me/fs/?uuid=' + token,
    ]) {
      const response = handler(new Request(url));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Мини-страница недоступна.');
    }
    const head = handler(new Request(result.url, { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(Number(head.headers.get('Content-Length'))).toBeGreaterThan(0);
    expect(await head.text()).toBe('');
    expect(handler(new Request(result.url, { method: 'POST' })).status).toBe(
      405,
    );
    expect(
      miniPageHandler(s.store, () => Date.parse(result.expires_at))(
        new Request(result.url),
      ).status,
    ).toBe(404);
    s.config.miniPages.enabled = false;
    expect(
      publicArtifactHandler(s.config, s.store)(new Request(result.url)).status,
    ).toBe(404);
  } finally {
    s.store.close();
  }
});

test('page snapshots share file quotas, active counts and expiration; SQLite reopen preserves links and old state', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'goodkiddo-page-check-'));
  let store = new AssistantStore(join(folder, 'assistant.db'));
  try {
    const limits = fileConfig().fileLimits;
    const files = new AssistantFiles(store.db, limits);
    files.write('a', '/private.txt', textBytes('private'));
    store.setState('synthetic_old_state', 'preserved');
    const values = {
      chatId: 'a',
      ownerId: 'owner',
      sourcePath: '/page.html',
      title: 'test',
      html: '<h1>persisted</h1>',
      hours: 1 / 60,
    };
    expect(() =>
      publishMiniPage(store.db, { ...limits, maxChatBytes: 8 }, values),
    ).toThrow('объёма файлов');
    expect(store.db.query('SELECT * FROM assistant_mini_pages').all()).toEqual(
      [],
    );
    const page = publishMiniPage(store.db, limits, values);
    expect(() =>
      new AssistantFiles(store.db, { ...limits, maxTotalBytes: 25 }).write(
        'b',
        '/new.txt',
        textBytes('xx'),
      ),
    ).toThrow('общий лимит');
    store.close();
    store = new AssistantStore(join(folder, 'assistant.db'));
    expect(store.state('synthetic_old_state')).toBe('preserved');
    expect(
      await miniPageHandler(store)(new Request(miniPageUrl(page.token))).text(),
    ).toBe('<h1>persisted</h1>');
    expireMiniPages(store.db, page.expiresAt);
    expect(listMiniPages(store.db, 'a')).toEqual([]);
    expect(
      new TextDecoder().decode(
        new AssistantFiles(store.db).get('a', '/private.txt').content,
      ),
    ).toBe('private');
    for (let i = 0; i < 20; i++)
      publishMiniPage(store.db, limits, { ...values, hours: 24 });
    expect(() => publishMiniPage(store.db, limits, values)).toThrow(
      'Лимит активных',
    );
    expect(() =>
      publishMiniPage(store.db, limits, { ...values, hours: 25 }),
    ).toThrow('24');
    expect(() =>
      publishMiniPage(store.db, limits, { ...values, hours: 0 }),
    ).toThrow();
    expect(
      Object.values(store.db.query('PRAGMA quick_check').get() as object),
    ).toEqual(['ok']);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
