import { test, expect } from 'bun:test';
import { load } from 'cheerio';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantStore } from '../src/persistence/assistant-store.ts';
import { AssistantFiles } from '../src/persistence/assistant-files.ts';
import { textBytes } from '../src/persistence/assistant-file-policy.ts';
import { createFolderFileGrant } from '../src/persistence/assistant-file-grants.ts';
import { expireFileGrants } from '../src/persistence/assistant-file-quota.ts';
import { expireMiniPages } from '../src/persistence/assistant-page-expiry.ts';
import { executeTool, type ToolContext } from '../src/assistant/tools.ts';
import { publicArtifactHandler } from '../src/server/assistant-file-links.ts';
import { fileConfig } from './fixtures/file-assistant-config.ts';

const request = (input: string | URL, init?: RequestInit) =>
  new Request(input.toString(), init);

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/f1sAAAAASUVORK5CYII=',
  'base64',
);
function setup(database = ':memory:') {
  const store = new AssistantStore(database);
  const config = fileConfig();
  config.fileShares.enabled = true;
  config.miniPages.enabled = true;
  const files = new AssistantFiles(store.db, config.fileLimits);
  files.write(
    'a',
    '/site/index.html',
    textBytes(
      '<h1>Own page</h1><link rel="stylesheet" href="assets/css/main.css"><img src="assets/pixel.png"><div style="background:url(assets/pixel.png)">Card</div><a href="about.html">About</a><script src="app.js">steal()</script>',
    ),
  );
  files.write(
    'a',
    '/site/about.html',
    textBytes('<h1>About own page</h1><a href="index.html">Home</a>'),
  );
  files.write(
    'a',
    '/site/assets/css/main.css',
    textBytes(
      '@import "nested.css"; @font-face{font-family:own;src:url(../font.woff2)} body{color:green;background:url(../pixel.png)}.bad{background:url(https://tracker.invalid/secret)}',
    ),
  );
  files.write(
    'a',
    '/site/assets/css/nested.css',
    textBytes('h1{font-weight:700}'),
  );
  files.write('a', '/site/assets/pixel.png', png);
  files.write('a', '/site/assets/font.woff2', Buffer.from('wOF2synthetic'));
  files.write('a', '/site/unused.css', textBytes('UNREFERENCED_CSS_SECRET'));
  files.write(
    'a',
    '/site/fake.png',
    textBytes('<script>not an image</script>'),
  );
  files.write('a', '/private.txt', textBytes('UNSELECTED_PRIVATE_SECRET'));
  files.write('b', '/site/index.html', textBytes('FOREIGN_HTML_SECRET'));
  files.write('b', '/site/foreign.css', textBytes('FOREIGN_CSS_SECRET'));
  const ctx: ToolContext = {
    store,
    config,
    taskId: 'synthetic-browser-task',
    searches: 0,
    signal: new AbortController().signal,
    request: {
      updateId: 1,
      interaction: 'message',
      chat: { id: 'a', type: 'private', timezone: 'UTC', active: 1 },
      actor: { id: 'owner', name: 'Synthetic' },
      text: 'Дай браузерную ссылку на папку /site/',
      userText: 'Дай браузерную ссылку на папку /site/',
    },
  };
  return { store, config, files, ctx };
}
type BrowserGrant = {
  url: string;
  expires_at: string;
  html_previews: { ordinal: number; id: string; url: string }[];
};

test('folder browser navigates actual selected hierarchy, safely previews text/images and opens isolated HTML with referenced assets', async () => {
  const s = setup();
  try {
    const grant = (await executeTool(
      'grant_fs_access',
      JSON.stringify({ scope_path: '/site/' }),
      s.ctx,
    )) as BrowserGrant;
    const handler = publicArtifactHandler(s.config, s.store);
    const response = handler(request(grant.url));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toContain(
      'allow-popups allow-popups-to-escape-sandbox',
    );
    const html = await response.text();
    const $ = load(html);
    expect(html).toContain('index.html');
    expect(html).toContain('assets/');
    expect(html).not.toContain('UNSELECTED_PRIVATE_SECRET');
    expect(html).not.toContain('FOREIGN_HTML_SECRET');
    const folder = new URL(
      $('a')
        .filter((_, node) => $(node).text() === 'assets/')
        .attr('href')!,
      grant.url,
    );
    const nested = await handler(request(folder)).text();
    expect(nested).toContain('pixel.png');
    expect(nested).toContain('css/');
    expect(nested).not.toContain('index.html');
    const imageListing = load(nested);
    const imagePreviewUrl = new URL(
      imageListing('a')
        .filter((_, node) => imageListing(node).text() === 'pixel.png')
        .attr('href')!,
      grant.url,
    );
    const imagePreview = load(await handler(request(imagePreviewUrl)).text());
    const browserImage = handler(
      request(new URL(imagePreview('img').attr('src')!, grant.url)),
    );
    expect(browserImage.headers.get('Content-Type')).toBe('image/png');
    expect(Buffer.from(await browserImage.arrayBuffer())).toEqual(png);
    const fakeOrdinal = (
      s.store.db
        .query(
          "SELECT ordinal FROM assistant_file_grant_items WHERE path='/site/fake.png'",
        )
        .get() as { ordinal: number }
    ).ordinal;
    const fileCapability = new URL(grant.url).searchParams.get('uuid');
    expect(
      handler(
        request(
          `https://app.whosagoodkiddo.me/fs/${fileCapability}/image/${fakeOrdinal}`,
        ),
      ).status,
    ).toBe(404);
    const parent = load(nested)('a')
      .filter((_, node) => load(nested)(node).text() === '← На уровень выше')
      .attr('href')!;
    expect(handler(request(new URL(parent, grant.url))).status).toBe(200);
    const textPreview = new URL(
      $('a')
        .filter((_, node) => $(node).text() === 'index.html')
        .attr('href')!,
      grant.url,
    );
    const sourcePreview = await handler(request(textPreview)).text();
    expect(sourcePreview).toContain('&lt;h1&gt;Own page&lt;/h1&gt;');
    expect(sourcePreview).not.toContain('<script');
    const page = grant.html_previews.find((preview) =>
      preview.url.endsWith('/site/index.html'),
    )!;
    expect(page.url).toStartWith('https://whosagoodkiddo.me/p/');
    expect(grant.url).toStartWith('https://app.whosagoodkiddo.me/fs/');
    const pageResponse = handler(
      request(page.url, {
        headers: {
          Cookie: 'PRIVATE_AUTH',
          Authorization: 'Bearer PRIVATE_AUTH',
        },
      }),
    );
    const pageHtml = await pageResponse.text();
    const parsed = load(pageHtml);
    expect(pageHtml).toContain('<h1>Own page</h1>');
    expect(pageHtml).not.toContain('<script');
    expect(pageHtml).not.toContain('PRIVATE_AUTH');
    const cssUrl = new URL(
      parsed('link[rel=stylesheet]').attr('href')!,
      page.url,
    );
    const css = handler(request(cssUrl));
    expect(css.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
    expect(css.headers.get('Cross-Origin-Resource-Policy')).toBe(
      'cross-origin',
    );
    const cssText = await css.text();
    expect(cssText).toContain('color:green');
    expect(cssText).not.toContain('tracker.invalid');
    const cssImport = cssText.match(/@import "([^"]+)"/)![1];
    expect(await handler(request(new URL(cssImport, cssUrl))).text()).toBe(
      'h1{font-weight:700}',
    );
    const fontUrl = cssText.match(/src:url\("([^"]+)"\)/)![1];
    const font = handler(request(fontUrl));
    expect(font.headers.get('Content-Type')).toBe('font/woff2');
    expect(font.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(font.headers.has('Access-Control-Allow-Credentials')).toBe(false);
    expect(await font.text()).toBe('wOF2synthetic');
    const imageUrl = new URL(parsed('img').attr('src')!, page.url);
    const image = handler(request(imageUrl));
    expect(image.headers.get('Content-Type')).toBe('image/png');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect(pageHtml).toContain(imageUrl.href);
    const about = new URL(
      parsed('a')
        .filter((_, node) => parsed(node).text() === 'About')
        .attr('href')!,
      page.url,
    );
    expect(await handler(request(about)).text()).toContain('About own page');
    const token = new URL(page.url).pathname.split('/')[2];
    const csp = pageResponse.headers.get('Content-Security-Policy')!;
    expect(csp).toContain(`https://whosagoodkiddo.me/p/${token}/`);
    expect(csp).toContain("script-src 'none'");
    expect(csp).not.toContain('allow-same-origin');
    for (const path of [
      '/site/unused.css',
      '/private.txt',
      '/site/foreign.css',
      '/site/app.js',
    ])
      expect(
        handler(request(`https://whosagoodkiddo.me/p/${token}${path}`)).status,
      ).toBe(404);
    const fileToken = new URL(grant.url).searchParams.get('uuid')!;
    expect(fileToken).not.toBe(token);
    expect(
      handler(
        request(`https://whosagoodkiddo.me/p/${fileToken}/site/index.html`),
      ).status,
    ).toBe(404);
    expect(
      handler(request(`https://app.whosagoodkiddo.me/fs/?uuid=${token}`))
        .status,
    ).toBe(404);
    for (const directory of ['/private/', '/site/../', '/other-chat/'])
      expect(
        handler(
          request(
            `https://app.whosagoodkiddo.me/fs/?uuid=${fileToken}&dir=${encodeURIComponent(directory)}`,
          ),
        ).status,
      ).toBe(404);
    // Edits and new files do not expand either capability.
    s.files.edit('a', '/site/assets/css/main.css', 'color:green', 'color:red');
    s.files.write('a', '/site/new.txt', textBytes('NEW_PRIVATE'));
    expect(await handler(request(cssUrl)).text()).toContain('color:green');
    expect(await handler(request(grant.url)).text()).not.toContain('new.txt');
    expect(
      await executeTool('revoke_page', JSON.stringify({ id: page.id }), s.ctx),
    ).toEqual({ revoked: page.id });
    expect(handler(request(page.url)).status).toBe(404);
    expect(handler(request(cssUrl)).status).toBe(404);
    expect(handler(request(grant.url)).status).toBe(200);
    expect(await handler(request(grant.url)).text()).not.toContain(page.url);
    expireMiniPages(s.store.db, Date.parse(grant.expires_at));
    expireFileGrants(s.store.db, Date.parse(grant.expires_at));
    expect(handler(request(grant.url)).status).toBe(404);
    expect(
      s.store.db.query('SELECT * FROM assistant_mini_page_assets').all(),
    ).toEqual([]);
    expect(s.files.get('a', '/private.txt').content).toEqual(
      textBytes('UNSELECTED_PRIVATE_SECRET'),
    );
  } finally {
    s.store.close();
  }
});

test('browser/asset capabilities survive SQLite reopen, share quotas, support metadata-only HEAD and release bounded response slots', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'goodkiddo-browser-check-'));
  const database = join(folder, 'assistant.db');
  const s = setup(database);
  let store = s.store;
  try {
    const grant = (await executeTool(
      'grant_fs_access',
      JSON.stringify({ scope_path: '/site/' }),
      s.ctx,
    )) as BrowserGrant;
    const page = grant.html_previews.find((preview) =>
      preview.url.endsWith('/site/index.html'),
    )!;
    store.close();
    store = new AssistantStore(database);
    const handler = publicArtifactHandler(s.config, store);
    expect(await handler(request(grant.url)).text()).toContain('index.html');
    const html = load(await handler(request(page.url)).text());
    const imageUrl = html('img').attr('src')!;
    const head = handler(request(imageUrl, { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe(String(png.length));
    expect(await head.text()).toBe('');
    const active = Array.from({ length: 4 }, () => handler(request(imageUrl)));
    expect(active.every((response) => response.status === 200)).toBe(true);
    expect(handler(request(imageUrl)).status).toBe(503);
    await active[0].body!.cancel();
    expect(Buffer.from(await handler(request(imageUrl)).arrayBuffer())).toEqual(
      png,
    );
    for (const response of active.slice(1)) await response.body!.cancel();
    const otherBytes = (
      store.db
        .query(
          `SELECT SUM(n) AS n FROM (
      SELECT length(content) AS n FROM assistant_files WHERE chat_id='a'
      UNION ALL SELECT length(content) FROM assistant_file_grant_items WHERE chat_id='a'
      UNION ALL SELECT length(content) FROM assistant_mini_pages WHERE chat_id='a')`,
        )
        .get() as { n: number }
    ).n;
    const assetBytes = (
      store.db
        .query(
          "SELECT SUM(length(content)) AS n FROM assistant_mini_page_assets WHERE chat_id='a'",
        )
        .get() as { n: number }
    ).n;
    expect(assetBytes).toBeGreaterThan(0);
    const bounded = new AssistantFiles(store.db, {
      ...s.config.fileLimits,
      maxChatBytes: otherBytes + 1,
    });
    expect(() => bounded.write('a', '/extra.txt', textBytes('x'))).toThrow(
      'объёма файлов',
    );
    expect(
      Object.values(store.db.query('PRAGMA quick_check').get() as object),
    ).toEqual(['ok']);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('direct page bundles select same-chat assets atomically and never publish the whole VFS', async () => {
  const s = setup();
  try {
    s.ctx.request.userText = 'Создай мини-страницу и дай ссылку';
    const args = {
      file_path: '/site/index.html',
      title: 'Own page',
      asset_paths: [
        '/site/assets/css/main.css',
        '/site/assets/css/nested.css',
        '/site/assets/pixel.png',
        '/site/about.html',
      ],
    };
    await expect(
      executeTool(
        'publish_page',
        JSON.stringify({
          ...args,
          asset_paths: [...args.asset_paths, '/site/foreign.css'],
        }),
        s.ctx,
      ),
    ).rejects.toThrow('Файл не найден');
    expect(
      s.store.db.query('SELECT * FROM assistant_mini_pages').all(),
    ).toEqual([]);
    expect(
      s.store.db.query('SELECT * FROM assistant_mini_page_assets').all(),
    ).toEqual([]);
    s.files.write(
      'a',
      '/site/evil.svg',
      textBytes('<svg onload="steal()"></svg>'),
    );
    await expect(
      executeTool(
        'publish_page',
        JSON.stringify({ ...args, asset_paths: ['/site/evil.svg'] }),
        s.ctx,
      ),
    ).rejects.toThrow('SVG');
    const result = (await executeTool(
      'publish_page',
      JSON.stringify(args),
      s.ctx,
    )) as { url: string };
    const handler = publicArtifactHandler(s.config, s.store);
    const pageHtml = await handler(request(result.url)).text();
    const cssUrl = load(pageHtml)('link').attr('href')!;
    expect(
      await handler(request(new URL(cssUrl, result.url))).text(),
    ).toContain('color:green');
    expect(
      handler(
        request(
          new URL(cssUrl.replace('main.css', '../../unused.css'), result.url),
        ),
      ).status,
    ).toBe(404);
    expect(pageHtml).not.toContain('UNREFERENCED_CSS_SECRET');
    expect(pageHtml).not.toContain('FOREIGN_HTML_SECRET');
  } finally {
    s.store.close();
  }
});

test('folder grants require explicit current-author selection, forbid root and bound all descendants', async () => {
  const s = setup();
  try {
    for (const text of [
      'Прочитай папку /site/',
      '> Дай ссылку на папку /site/',
      'Не публикуй ссылку на папку /site/',
    ]) {
      s.ctx.request.userText = text;
      await expect(
        executeTool(
          'grant_fs_access',
          JSON.stringify({ scope_path: '/site/' }),
          s.ctx,
        ),
      ).rejects.toThrow('явная просьба');
    }
    expect(
      s.store.db.query('SELECT * FROM assistant_file_grants').all(),
    ).toEqual([]);
    s.files.write('a', '/oversize/index.html', textBytes('x'.repeat(262145)));
    s.ctx.request.userText = 'Дай ссылку на папку /oversize/';
    await expect(
      executeTool(
        'grant_fs_access',
        JSON.stringify({ scope_path: '/oversize/' }),
        s.ctx,
      ),
    ).rejects.toThrow('256');
    expect(
      s.store.db.query('SELECT * FROM assistant_file_grants').all(),
    ).toEqual([]);
    expect(
      s.store.db.query('SELECT * FROM assistant_mini_pages').all(),
    ).toEqual([]);
    expect(() => createFolderFileGrant(s.store.db, s.files, 'a', '/')).toThrow(
      'Корень',
    );
    expect(() =>
      createFolderFileGrant(s.store.db, s.files, 'b', '/site/assets/'),
    ).toThrow('непустую');
    for (let i = 0; i < 101; i++)
      s.files.write('a', `/too-large/${i}.txt`, textBytes('x'));
    expect(() =>
      createFolderFileGrant(s.store.db, s.files, 'a', '/too-large/'),
    ).toThrow('100');
    expect(
      s.store.db.query('SELECT * FROM assistant_file_grants').all(),
    ).toEqual([]);
  } finally {
    s.store.close();
  }
});
