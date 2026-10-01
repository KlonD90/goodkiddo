import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantStore } from '../src/persistence/assistant-store.ts';
import { AssistantFiles } from '../src/persistence/assistant-files.ts';
import { textBytes } from '../src/persistence/assistant-file-policy.ts';
import {
  createFileGrant,
  fileGrant,
} from '../src/persistence/assistant-file-grants.ts';
import { expireFileGrants } from '../src/persistence/assistant-file-quota.ts';
import {
  fileLinkHandler,
  fileGrantUrl,
  startFileLinkServer,
} from '../src/server/assistant-file-links.ts';
import {
  executeTool,
  toolDefinitions,
  type ToolContext,
} from '../src/assistant/tools.ts';
import { fileConfig } from './fixtures/file-assistant-config.ts';

function setup() {
  const config = fileConfig(),
    store = new AssistantStore(':memory:'),
    files = new AssistantFiles(store.db, config.fileLimits);
  const request = {
    updateId: 1,
    chat: { id: 'a', type: 'private' as const, timezone: 'UTC', active: 1 },
    actor: { id: 'a', name: 'Synthetic' },
    text: 'Дай ссылку на файл report.txt',
    userText: 'Дай ссылку на файл report.txt',
    interaction: 'message' as const,
  };
  const ctx: ToolContext = {
    store,
    config,
    request,
    taskId: 'test-task',
    signal: new AbortController().signal,
    searches: 0,
  };
  files.write('a', '/report.txt', textBytes('shared synthetic'));
  return { store, files, config, ctx };
}
function downloadUrl(token: string, ordinal = 0, name = 'report.txt'): string {
  return `https://app.whosagoodkiddo.me/fs/${token}/${ordinal}/${encodeURIComponent(name)}`;
}

test('grant snapshots only selected current-chat files and stores only hashed capability', async () => {
  const s = setup();
  try {
    s.files.write('a', '/private.txt', textBytes('never shared'));
    s.files.write('b', '/report.txt', textBytes('other chat'));
    const grant = createFileGrant(s.store.db, s.files, 'a', ['/report.txt']);
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = s.store.db
      .query('SELECT * FROM assistant_file_grants')
      .get() as { token_hash: string };
    expect(row.token_hash).not.toContain(grant.token);
    expect(row.token_hash.length).toBe(64);
    expect(fileGrant(s.store.db, grant.token)?.files).toEqual([
      { ordinal: 0, filename: 'report.txt', size: 16 },
    ]);
    s.files.edit('a', '/report.txt', 'shared', 'edited');
    s.files.write('a', '/new.txt', textBytes('new'));
    const handler = fileLinkHandler(s.store),
      index = handler(
        new Request(
          fileGrantUrl(s.config.fileShares.publicBaseUrl, grant.token),
        ),
      );
    const html = await index.text();
    expect(html).toContain('report.txt');
    expect(html).not.toContain('private.txt');
    expect(html).not.toContain('new.txt');
    expect(html).not.toContain('other chat');
    const response = handler(new Request(downloadUrl(grant.token)));
    expect(await response.text()).toBe('shared synthetic');
    expect(
      handler(new Request(downloadUrl(grant.token, 1, 'private.txt'))).status,
    ).toBe(404);
    expect(() =>
      createFileGrant(s.store.db, s.files, 'b', ['/private.txt']),
    ).toThrow('Файл не найден');
  } finally {
    s.store.close();
  }
});
test('guessed, malformed, expired and traversal URLs have uniform failures; TTL is bounded', async () => {
  const s = setup();
  try {
    const now = Date.now(),
      grant = createFileGrant(
        s.store.db,
        s.files,
        'a',
        ['/report.txt'],
        1 / 60,
        now,
      ),
      handler = fileLinkHandler(s.store, () => now);
    for (const url of [
      'https://app.whosagoodkiddo.me/fs/',
      fileGrantUrl(s.config.fileShares.publicBaseUrl, 'x'.repeat(43)),
      downloadUrl(grant.token, 0, '../private.txt'),
      downloadUrl(grant.token, 19, 'report.txt'),
      `https://app.whosagoodkiddo.me/fs/${grant.token}/00/report.txt`,
      `https://app.whosagoodkiddo.me/fs/${grant.token}/0/%00`,
    ])
      expect(handler(new Request(url)).status).toBe(404);
    expect(fileGrant(s.store.db, grant.token, now + 60000)).toBeUndefined();
    expect(
      fileLinkHandler(
        s.store,
        () => now + 60000,
      )(new Request(downloadUrl(grant.token))).status,
    ).toBe(404);
    expect(() =>
      createFileGrant(s.store.db, s.files, 'a', ['/report.txt'], 25),
    ).toThrow('24');
    expect(() =>
      createFileGrant(s.store.db, s.files, 'a', ['/report.txt'], 0),
    ).toThrow();
    expect(() => createFileGrant(s.store.db, s.files, 'a', ['/'])).toThrow();
    expect(() =>
      createFileGrant(s.store.db, s.files, 'a', ['/../etc/passwd']),
    ).toThrow();
    expect(() => createFileGrant(s.store.db, s.files, 'a', [])).toThrow();
    expireFileGrants(s.store.db, now + 60000);
    expect(
      s.store.db.query('SELECT * FROM assistant_file_grant_items').all(),
    ).toEqual([]);
  } finally {
    s.store.close();
  }
});
test('HTML and SVG are attachment bytes; listing escapes filenames and prevents caching/referrer leakage', async () => {
  const s = setup();
  try {
    const name = '<script>alert(1).html';
    s.files.write(
      'a',
      '/' + name,
      textBytes('<script>synthetic</script>'),
      'text/html',
    );
    const grant = createFileGrant(s.store.db, s.files, 'a', ['/' + name]),
      handler = fileLinkHandler(s.store);
    const response = handler(new Request(downloadUrl(grant.token, 0, name)));
    expect(response.headers.get('Content-Type')).toBe(
      'application/octet-stream',
    );
    expect(response.headers.get('Content-Disposition')).toStartWith(
      'attachment;',
    );
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(await response.text()).toContain('<script>synthetic');
    const listing = handler(
      new Request(fileGrantUrl(s.config.fileShares.publicBaseUrl, grant.token)),
    );
    expect(listing.headers.get('Content-Security-Policy')).toContain(
      "default-src 'none'",
    );
    const html = await listing.text();
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    const head = handler(
      new Request(downloadUrl(grant.token, 0, name), { method: 'HEAD' }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(
      handler(
        new Request(downloadUrl(grant.token, 0, name), {
          method: 'POST',
          body: 'synthetic',
        }),
      ).status,
    ).toBe(405);
  } finally {
    s.store.close();
  }
});
test('grant snapshots count against chat/global quotas and expire without deleting original files', () => {
  const s = setup();
  try {
    const limits = {
      ...s.config.fileLimits,
      maxChatBytes: 17,
      maxTotalBytes: 17,
    };
    const bounded = new AssistantFiles(s.store.db, limits);
    expect(() =>
      createFileGrant(s.store.db, bounded, 'a', ['/report.txt']),
    ).toThrow('объёма файлов');
    expect(
      s.store.db.query('SELECT * FROM assistant_file_grants').all(),
    ).toEqual([]);
    const grant = createFileGrant(
      s.store.db,
      s.files,
      'a',
      ['/report.txt'],
      1 / 60,
    );
    expect(() => bounded.write('a', '/extra.txt', textBytes('x'))).toThrow();
    expireFileGrants(s.store.db, grant.expiresAt);
    bounded.write('a', '/extra.txt', textBytes('x'));
    expect(s.files.read('a', '/report.txt').text).toContain('shared synthetic');
    for (let i = 0; i < 20; i++)
      createFileGrant(s.store.db, s.files, 'a', ['/report.txt']);
    expect(() =>
      createFileGrant(s.store.db, s.files, 'a', ['/report.txt']),
    ).toThrow('активных ссылок');
  } finally {
    s.store.close();
  }
});
test('browser tool and listener remain disabled unless configured; explicit author request is required', async () => {
  const s = setup();
  try {
    expect(
      toolDefinitions(false).map((tool) => tool.function.name),
    ).not.toContain('grant_fs_access');
    expect(startFileLinkServer(s.config, s.store)).toBeUndefined();
    const input = JSON.stringify({ file_paths: ['/report.txt'] });
    await expect(executeTool('grant_fs_access', input, s.ctx)).rejects.toThrow(
      'не включены',
    );
    s.config.fileShares.enabled = true;
    expect(
      toolDefinitions(false, true).map((tool) => tool.function.name),
    ).toContain('grant_fs_access');
    for (const text of [
      'Создай и отправь файл report.txt',
      'Прочитай файл report.txt',
      '> Дай ссылку на файл report.txt',
      'Не публикуй ссылку на файл report.txt',
      '',
    ]) {
      s.ctx.request.userText = text;
      await expect(
        executeTool('grant_fs_access', input, s.ctx),
      ).rejects.toThrow('явная просьба');
    }
    s.ctx.request.userText = 'Дай ссылку на файл report.txt';
    s.ctx.request.forwarded = true;
    await expect(
      executeTool('grant_fs_access', input, s.ctx),
    ).rejects.toThrow();
    s.ctx.request.forwarded = false;
    const result = (await executeTool('grant_fs_access', input, s.ctx)) as {
      url: string;
      expires_at: string;
    };
    expect(result.url).toStartWith('https://app.whosagoodkiddo.me/fs/?uuid=');
    expect(Date.parse(result.expires_at) - Date.now()).toBeLessThanOrEqual(
      86400000,
    );
    await expect(
      executeTool(
        'grant_fs_access',
        JSON.stringify({ scope_path: '/' }),
        s.ctx,
      ),
    ).rejects.toThrow();
    expect(
      s.store.db.query('SELECT * FROM assistant_file_grants').all().length,
    ).toBe(1);
  } finally {
    s.store.close();
  }
});
test('links survive SQLite reopen and download concurrency is bounded with cancellation recovery', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'goodkiddo-grant-check-')),
    path = join(folder, 'assistant.db');
  let store = new AssistantStore(path);
  try {
    const files = new AssistantFiles(store.db);
    files.write('a', '/large.txt', textBytes('x'.repeat(131073)));
    const grant = createFileGrant(store.db, files, 'a', ['/large.txt']);
    store.close();
    store = new AssistantStore(path);
    const handler = fileLinkHandler(store),
      url = downloadUrl(grant.token, 0, 'large.txt');
    const pending = Array.from({ length: 4 }, () => handler(new Request(url)));
    expect(pending.every((response) => response.status === 200)).toBe(true);
    expect(handler(new Request(url)).status).toBe(503);
    await pending[0].body!.cancel();
    const replacement = handler(new Request(url));
    expect(replacement.status).toBe(200);
    expect((await replacement.arrayBuffer()).byteLength).toBe(131073);
    for (const response of pending.slice(1)) await response.body!.cancel();
    expect(
      handler(new Request(url, { method: 'HEAD' })).headers.get(
        'Content-Length',
      ),
    ).toBe('131073');
    expect(
      Object.values(store.db.query('PRAGMA quick_check').get() as object),
    ).toEqual(['ok']);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
