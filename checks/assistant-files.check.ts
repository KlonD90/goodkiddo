import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantStore } from '../src/persistence/assistant-store.ts';
import { ASSISTANT_SCHEMA as PREVIOUS_SCHEMA } from './fixtures/assistant-schema-before-files.ts';
import { AssistantFiles } from '../src/persistence/assistant-files.ts';
import {
  textBytes,
  virtualPath,
  documentName,
  safeMimeType,
} from '../src/persistence/assistant-file-policy.ts';

function memory() {
  const store = new AssistantStore(':memory:');
  return { store, files: new AssistantFiles(store.db) };
}

test('virtual paths reject traversal, control bytes, Windows/UNC and ambiguous separators', () => {
  for (const input of [
    '../secret',
    '/a/../secret',
    'a\\..\\secret',
    'C:/secret',
    '//host/share',
    '/~secret',
    '/a\0b',
    '/a\nb',
  ])
    expect(() => virtualPath(input)).toThrow();
  expect(virtualPath('./reports//one.txt')).toBe('/reports/one.txt');
  expect(virtualPath('/reports', true)).toBe('/reports/');
  expect(documentName('../../report.csv')).toBe('report.csv');
  expect(documentName('..')).toBe('document');
  expect(safeMimeType('text/html\r\nSet-Cookie:bad')).toBe(
    'application/octet-stream',
  );
});

test('same filenames are isolated by chat; virtual host paths never read the host', () => {
  const { store, files } = memory();
  try {
    files.write('private-a', '/report.txt', textBytes('private-a'));
    files.write('group-b', '/report.txt', textBytes('group-b'));
    expect(files.read('private-a', '/report.txt').text).toBe('1: private-a');
    expect(files.read('group-b', '/report.txt').text).toBe('1: group-b');
    expect(() => files.get('other-chat', '/report.txt')).toThrow();
    expect(() => files.get('private-a', '/etc/passwd')).toThrow(
      'Файл не найден',
    );
    expect(files.grep('private-a', 'group-b').matches).toEqual([]);
  } finally {
    store.close();
  }
});

test('write and upload origin deduplicate without overwriting later changes', () => {
  const { store, files } = memory();
  try {
    files.write(
      'chat',
      '/one.txt',
      textBytes('hello'),
      'text/plain',
      'telegram:1',
    );
    files.write('chat', '/one.txt', textBytes('hello'));
    expect(() => files.write('chat', '/one.txt', textBytes('other'))).toThrow(
      'уже существует',
    );
    files.edit('chat', '/one.txt', 'hello', 'changed');
    expect(
      files.write(
        'chat',
        '/other-path.txt',
        textBytes('hello'),
        'text/plain',
        'telegram:1',
      ).path,
    ).toBe('/one.txt');
    expect(files.read('chat', '/one.txt').text).toBe('1: changed');
    expect(files.list('chat').length).toBe(1);
  } finally {
    store.close();
  }
});

test('file size, per-chat bytes/count and global quota reject atomically', () => {
  const store = new AssistantStore(':memory:');
  const files = new AssistantFiles(store.db, {
    maxFileBytes: 8,
    maxChatBytes: 10,
    maxChatFiles: 2,
    maxTotalBytes: 12,
  });
  try {
    expect(() =>
      files.write('a', '/large.txt', textBytes('123456789')),
    ).toThrow('размер');
    files.write('a', '/first.txt', textBytes('123456'));
    expect(() => files.write('a', '/second.txt', textBytes('12345'))).toThrow(
      'объёма файлов',
    );
    files.write('a', '/second.txt', textBytes('12'));
    expect(() => files.write('a', '/third.txt', textBytes('1'))).toThrow(
      'числа файлов',
    );
    files.write('b', '/file.txt', textBytes('1234'));
    expect(() => files.write('b', '/extra.txt', textBytes('1'))).toThrow(
      'общий лимит',
    );
    expect(() => files.edit('a', '/first.txt', '1', '1234567890')).toThrow(
      'размер',
    );
    expect(files.read('a', '/first.txt').text).toBe('1: 123456');
    expect(files.list('a').length).toBe(2);
  } finally {
    store.close();
  }
});

test('list/glob/grep/read are scoped, paginated, bounded and binary-safe', () => {
  const { store, files } = memory();
  try {
    files.write('a', '/reports/one.csv', textBytes('first\nhello\nlast'));
    files.write('a', '/reports/two.txt', textBytes('HELLO'));
    files.write(
      'a',
      '/reports/binary.bin',
      new Uint8Array([255, 0, 254]),
      'application/octet-stream',
    );
    files.write('a', '/reports-old/other.csv', textBytes('hello'));
    expect(files.list('a', '/reports/').length).toBe(3);
    expect(
      files.glob('a', '*.csv', '/reports/').files.map((x) => x.path),
    ).toEqual(['/reports/one.csv']);
    expect(files.read('a', '/reports/one.csv', 1, 1)).toMatchObject({
      text: '2: hello',
      next_offset: 2,
    });
    expect(files.grep('a', 'hello', '/reports/', false).matches.length).toBe(2);
    expect(() => files.read('a', '/reports/binary.bin')).toThrow('двоичный');
    expect(() => files.read('a', '/reports/one.csv', -1)).toThrow();
    files.write('a', '/long.txt', textBytes('x'.repeat(20000)));
    expect(files.read('a', '/long.txt').text.length).toBeLessThanOrEqual(12000);
    expect(files.read('a', '/long.txt').truncated).toBe(true);
  } finally {
    store.close();
  }
});

test('literal edit avoids accidental multi-replacement and replacement expansion', () => {
  const { store, files } = memory();
  try {
    files.write('a', '/one.txt', textBytes('same same'));
    expect(() => files.edit('a', '/one.txt', 'same', 'new')).toThrow(
      'несколько раз',
    );
    files.edit('a', '/one.txt', 'same', '$&', true);
    expect(files.read('a', '/one.txt').text).toBe('1: $& $&');
    expect(() => files.edit('a', '/one.txt', '', 'new')).toThrow();
  } finally {
    store.close();
  }
});

test('additive schema preserves earlier chats/outbox and files survive repeated reopen', () => {
  const folder = mkdtempSync(join(tmpdir(), 'goodkiddo-file-store-test-'));
  const dbPath = join(folder, 'assistant.db');
  try {
    const previous = new Database(dbPath);
    previous.exec(PREVIOUS_SCHEMA);
    previous
      .query('INSERT INTO assistant_chats VALUES (?,?,?,?)')
      .run('chat', 'private', 'UTC', 1);
    previous
      .query(
        'INSERT INTO assistant_outbox(id,chat_id,text,next_attempt) VALUES (?,?,?,?)',
      )
      .run(
        'existing',
        'chat',
        'synthetic existing reply',
        new Date().toISOString(),
      );
    previous.close();
    let store = new AssistantStore(dbPath);
    new AssistantFiles(store.db).write(
      'chat',
      '/persisted.txt',
      textBytes('durable'),
    );
    store.close();
    store = new AssistantStore(dbPath);
    expect(
      new AssistantFiles(store.db).read('chat', '/persisted.txt').text,
    ).toBe('1: durable');
    expect(store.chat('chat')?.timezone).toBe('UTC');
    expect(
      (
        store.db
          .query('SELECT text FROM assistant_outbox WHERE id=?')
          .get('existing') as any
      ).text,
    ).toBe('synthetic existing reply');
    expect(
      Object.values(store.db.query('PRAGMA quick_check').get() as object),
    ).toEqual(['ok']);
    store.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
