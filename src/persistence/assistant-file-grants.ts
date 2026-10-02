import { createHash, randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { AssistantFiles } from './assistant-files.js';
import {
  AssistantFileError,
  documentName,
  virtualPath,
} from './assistant-file-policy.js';
import { checkFileQuota, expireFileGrants } from './assistant-file-quota.js';

export const MAX_FILE_GRANT_HOURS = 24;
export const MAX_FILE_GRANT_ITEMS = 20;
export const MAX_FOLDER_GRANT_ITEMS = 100;
export interface GrantedFile {
  ordinal: number;
  filename: string;
  size: number;
}
export interface FileGrant {
  token_hash: string;
  chat_id: string;
  expires_at: number;
  files: GrantedFile[];
}
function tokenHash(token: string): string | undefined {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    Buffer.from(token, 'base64url').toString('base64url') !== token
  )
    return undefined;
  return createHash('sha256').update(token).digest('hex');
}

/** Only explicit selected files are copied. Neither later edits nor new files expand a grant. */
export function createFileGrant(
  db: Database,
  files: AssistantFiles,
  chatId: string,
  inputs: string[],
  hours = 24,
  now = Date.now(),
  maximumItems = MAX_FILE_GRANT_ITEMS,
) {
  if (!Number.isFinite(hours) || hours < 1 / 60 || hours > MAX_FILE_GRANT_HOURS)
    throw new AssistantFileError('Срок ссылки — от минуты до 24 часов.');
  if (!inputs.length || inputs.length > maximumItems)
    throw new AssistantFileError(
      'Выберите от 1 до 20 файлов. Корень и папки не публикуются.',
    );
  const paths = [...new Set(inputs.map((input) => virtualPath(input)))];
  return db.transaction(() => {
    expireFileGrants(db, now);
    const active = db
      .query('SELECT COUNT(*) AS n FROM assistant_file_grants WHERE chat_id=?')
      .get(chatId) as { n: number };
    const all = db
      .query('SELECT COUNT(*) AS n FROM assistant_file_grants')
      .get() as { n: number };
    if (active.n >= 20 || all.n >= 1000)
      throw new AssistantFileError(
        'Лимит активных ссылок достигнут. Дождитесь истечения старых ссылок.',
      );
    const selected = paths.map((path) => files.get(chatId, path));
    checkFileQuota(
      db,
      files.limits,
      chatId,
      selected.reduce((n, file) => n + file.content.length, 0),
    );
    const token = randomBytes(32).toString('base64url');
    const hash = tokenHash(token)!;
    const expiresAt = now + Math.floor(hours * 3600_000);
    db.query(
      'INSERT INTO assistant_file_grants(token_hash,chat_id,expires_at,created_at) VALUES (?,?,?,?)',
    ).run(hash, chatId, expiresAt, new Date(now).toISOString());
    selected.forEach((file, ordinal) =>
      db
        .query(
          'INSERT INTO assistant_file_grant_items(token_hash,chat_id,ordinal,path,filename,mime_type,content) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          hash,
          chatId,
          ordinal,
          file.path,
          documentName(file.path),
          file.mime_type,
          file.content,
        ),
    );
    return {
      token,
      expiresAt,
      files: selected.map((file, ordinal) => ({
        ordinal,
        filename: documentName(file.path),
        size: file.size,
      })),
    };
  })();
}

/** A directory grant is a bounded snapshot, never a live root/namespace grant. */
export function createFolderFileGrant(
  db: Database,
  files: AssistantFiles,
  chatId: string,
  input: string,
  hours = 24,
  now = Date.now(),
) {
  const directory = virtualPath(input, true);
  if (directory === '/')
    throw new AssistantFileError(
      'Корень VFS не публикуется. Выберите конкретную папку.',
    );
  const entries = files.list(chatId, directory);
  if (!entries.length || entries.length > MAX_FOLDER_GRANT_ITEMS)
    throw new AssistantFileError(
      'Выберите непустую папку не больше 100 файлов.',
    );
  return createFileGrant(
    db,
    files,
    chatId,
    entries.map((file) => file.path),
    hours,
    now,
    MAX_FOLDER_GRANT_ITEMS,
  );
}

export function fileGrantEntries(
  db: Database,
  grant: FileGrant,
): (GrantedFile & { path: string; mime_type: string })[] {
  return db
    .query(
      'SELECT ordinal,path,filename,mime_type,length(content) AS size FROM assistant_file_grant_items WHERE token_hash=? AND chat_id=? ORDER BY path',
    )
    .all(grant.token_hash, grant.chat_id) as (GrantedFile & {
    path: string;
    mime_type: string;
  })[];
}

/** The HTML capability cannot be reversed into the broader file-browser capability. */
export function previewPageToken(fileToken: string, ordinal: number): string {
  if (
    !tokenHash(fileToken) ||
    !Number.isInteger(ordinal) ||
    ordinal < 0 ||
    ordinal >= MAX_FOLDER_GRANT_ITEMS
  )
    throw new Error('Invalid preview capability input.');
  return createHash('sha256')
    .update(`goodkiddo-static-preview:v1:${fileToken}:${ordinal}`)
    .digest('base64url');
}

export function fileGrant(
  db: Database,
  token: string,
  now = Date.now(),
): FileGrant | undefined {
  const hash = tokenHash(token);
  if (!hash) return undefined;
  const grant = db
    .query(
      'SELECT token_hash,chat_id,expires_at FROM assistant_file_grants WHERE token_hash=? AND expires_at>?',
    )
    .get(hash, now) as Omit<FileGrant, 'files'> | null;
  if (!grant) return undefined;
  const files = db
    .query(
      'SELECT ordinal,filename,length(content) AS size FROM assistant_file_grant_items WHERE token_hash=? AND chat_id=? ORDER BY ordinal',
    )
    .all(hash, grant.chat_id) as GrantedFile[];
  return { ...grant, files };
}

export function grantedFileBytes(
  db: Database,
  grant: FileGrant,
  ordinal: number,
): Uint8Array | undefined {
  const row = db
    .query(
      'SELECT content FROM assistant_file_grant_items WHERE token_hash=? AND chat_id=? AND ordinal=?',
    )
    .get(grant.token_hash, grant.chat_id, ordinal) as {
    content: Uint8Array;
  } | null;
  return row?.content;
}
