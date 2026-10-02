import type { Database } from 'bun:sqlite';
import { expireMiniPages } from './assistant-page-expiry.js';
import {
  AssistantFileError,
  type AssistantFileLimits,
} from './assistant-file-policy.js';

export function expireFileGrants(db: Database, now = Date.now()): void {
  db.transaction(() => {
    db.query(
      'DELETE FROM assistant_file_grant_items WHERE token_hash IN (SELECT token_hash FROM assistant_file_grants WHERE expires_at<=?)',
    ).run(now);
    db.query('DELETE FROM assistant_file_grants WHERE expires_at<=?').run(now);
  })();
}

export function checkFileQuota(
  db: Database,
  limits: AssistantFileLimits,
  chatId: string,
  additionalBytes: number,
): void {
  expireFileGrants(db);
  expireMiniPages(db);
  const sql = `SELECT chat_id,length(content) AS bytes FROM assistant_files
    UNION ALL SELECT chat_id,length(content) FROM assistant_file_deliveries WHERE content IS NOT NULL
    UNION ALL SELECT chat_id,length(content) FROM assistant_file_grant_items
    UNION ALL SELECT chat_id,length(content) FROM assistant_mini_pages`;
  const { bytes: chatBytes } = db
    .query(
      `SELECT COALESCE(SUM(bytes),0) AS bytes FROM (${sql}) WHERE chat_id=?`,
    )
    .get(chatId) as { bytes: number };
  const { bytes: totalBytes } = db
    .query(`SELECT COALESCE(SUM(bytes),0) AS bytes FROM (${sql})`)
    .get() as { bytes: number };
  if (chatBytes + additionalBytes > limits.maxChatBytes)
    throw new AssistantFileError('В этом чате достигнут лимит объёма файлов.');
  if (totalBytes + additionalBytes > limits.maxTotalBytes)
    throw new AssistantFileError(
      'Достигнут общий лимит объёма файлов GoodKiddo.',
    );
}
