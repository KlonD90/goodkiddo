import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { AssistantFileLimits } from './assistant-file-policy.js';
import { checkFileQuota } from './assistant-file-quota.js';
import { expireMiniPages } from './assistant-page-expiry.js';
import { MAX_MINI_PAGE_BYTES } from '../capabilities/pages/html.js';
import {
  MAX_PAGE_ASSETS,
  MAX_PAGE_ASSET_BYTES,
  MAX_PAGE_BUNDLE_BYTES,
  type MiniPageAsset,
} from '../capabilities/pages/resources.js';

export interface MiniPageSummary {
  id: string;
  title: string;
  source_path: string;
  created_at: string;
  expires_at: number;
}
function tokenHash(token: string): string | undefined {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    Buffer.from(token, 'base64url').toString('base64url') !== token
  )
    return undefined;
  return createHash('sha256').update(token).digest('hex');
}

/** Receives only prepared static bytes, never a host path or a client-selected chat. */
export function publishMiniPage(
  db: Database,
  limits: AssistantFileLimits,
  args: {
    chatId: string;
    ownerId: string;
    sourcePath: string;
    title: string;
    html: string;
    hours: number;
    assets?: MiniPageAsset[];
    token?: string;
  },
  now = Date.now(),
) {
  if (!Number.isFinite(args.hours) || args.hours < 1 / 60 || args.hours > 24)
    throw new Error('Срок мини-страницы — от минуты до 24 часов.');
  const bytes = Buffer.from(args.html, 'utf8');
  if (!bytes.length || bytes.length > MAX_MINI_PAGE_BYTES)
    throw new Error('Мини-страница превышает 256 КиБ.');
  const assets = args.assets || [];
  const totalBytes =
    bytes.length +
    assets.reduce((total, asset) => total + asset.content.length, 0);
  if (
    assets.length > MAX_PAGE_ASSETS ||
    assets.some(
      (asset) =>
        !asset.content.length || asset.content.length > MAX_PAGE_ASSET_BYTES,
    ) ||
    totalBytes > MAX_PAGE_BUNDLE_BYTES
  )
    throw new Error(
      'Снимок мини-страницы ограничен 40 ассетами, 2 МиБ на ассет и 5 МиБ суммарно.',
    );
  if (args.token && !tokenHash(args.token))
    throw new Error('Invalid page capability.');
  return db.transaction(() => {
    expireMiniPages(db, now);
    const own = db
      .query('SELECT COUNT(*) AS n FROM assistant_mini_pages WHERE chat_id=?')
      .get(args.chatId) as { n: number };
    const all = db
      .query('SELECT COUNT(*) AS n FROM assistant_mini_pages')
      .get() as { n: number };
    if (own.n >= 20 || all.n >= 1000)
      throw new Error(
        'Лимит активных мини-страниц достигнут. Отзовите ненужные ссылки.',
      );
    checkFileQuota(db, limits, args.chatId, totalBytes);
    const token = args.token || randomBytes(32).toString('base64url');
    const id = randomUUID().slice(0, 12);
    const expiresAt = now + Math.floor(args.hours * 3600_000);
    db.query(
      'INSERT INTO assistant_mini_pages(id,token_hash,chat_id,owner_id,source_path,title,content,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      tokenHash(token)!,
      args.chatId,
      args.ownerId,
      args.sourcePath,
      args.title,
      bytes,
      new Date(now).toISOString(),
      expiresAt,
    );
    for (const asset of assets)
      db.query(
        'INSERT INTO assistant_mini_page_assets(page_id,chat_id,path,mime_type,content) VALUES (?,?,?,?,?)',
      ).run(id, args.chatId, asset.path, asset.mimeType, asset.content);
    return { id, token, expiresAt };
  })();
}

export function miniPage(
  db: Database,
  token: string,
  now = Date.now(),
  includeContent = true,
) {
  const hash = tokenHash(token);
  if (!hash) return undefined;
  return db
    .query(
      `SELECT id,chat_id,source_path,length(content) AS size${includeContent ? ',content' : ''} FROM assistant_mini_pages WHERE token_hash=? AND expires_at>?`,
    )
    .get(hash, now) as {
    id: string;
    chat_id: string;
    source_path: string;
    size: number;
    content?: Uint8Array;
  } | null;
}
export function miniPageAsset(
  db: Database,
  page: { id: string; chat_id: string },
  path: string,
  includeContent: boolean,
) {
  return db
    .query(
      `SELECT mime_type,length(content) AS size${includeContent ? ',content' : ''} FROM assistant_mini_page_assets WHERE page_id=? AND chat_id=? AND path=?`,
    )
    .get(page.id, page.chat_id, path) as {
    mime_type: string;
    size: number;
    content?: Uint8Array;
  } | null;
}
export function listMiniPages(
  db: Database,
  chatId: string,
  now = Date.now(),
): MiniPageSummary[] {
  return db
    .query(
      'SELECT id,title,source_path,created_at,expires_at FROM assistant_mini_pages WHERE chat_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 20',
    )
    .all(chatId, now) as MiniPageSummary[];
}
export function revokeMiniPage(
  db: Database,
  chatId: string,
  ownerId: string,
  id: string,
) {
  return db.transaction(() => {
    const own = db
      .query(
        'SELECT id FROM assistant_mini_pages WHERE id=? AND chat_id=? AND owner_id=?',
      )
      .get(id, chatId, ownerId);
    if (!own)
      throw new Error(
        'Мини-страница не найдена среди ваших публикаций в этом чате.',
      );
    db.query('DELETE FROM assistant_file_page_previews WHERE page_id=?').run(
      id,
    );
    db.query('DELETE FROM assistant_mini_page_assets WHERE page_id=?').run(id);
    db.query(
      'DELETE FROM assistant_mini_pages WHERE id=? AND chat_id=? AND owner_id=?',
    ).run(id, chatId, ownerId);
    return { revoked: id };
  })();
}
