import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { AssistantFileLimits } from './assistant-file-policy.js';
import { checkFileQuota } from './assistant-file-quota.js';
import { expireMiniPages } from './assistant-page-expiry.js';
import { MAX_MINI_PAGE_BYTES } from '../capabilities/pages/html.js';

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
  },
  now = Date.now(),
) {
  if (!Number.isFinite(args.hours) || args.hours < 1 / 60 || args.hours > 24)
    throw new Error('Срок мини-страницы — от минуты до 24 часов.');
  const bytes = Buffer.from(args.html, 'utf8');
  if (!bytes.length || bytes.length > MAX_MINI_PAGE_BYTES)
    throw new Error('Мини-страница превышает 256 КиБ.');
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
    checkFileQuota(db, limits, args.chatId, bytes.length);
    const token = randomBytes(32).toString('base64url');
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
      `SELECT length(content) AS size${includeContent ? ',content' : ''} FROM assistant_mini_pages WHERE token_hash=? AND expires_at>?`,
    )
    .get(hash, now) as { size: number; content?: Uint8Array } | null;
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
  const removed = db
    .query(
      'DELETE FROM assistant_mini_pages WHERE id=? AND chat_id=? AND owner_id=?',
    )
    .run(id, chatId, ownerId);
  if (!removed.changes)
    throw new Error(
      'Мини-страница не найдена среди ваших публикаций в этом чате.',
    );
  return { revoked: id };
}
