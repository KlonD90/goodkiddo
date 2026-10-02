import type { Database } from 'bun:sqlite';
import {
  fileGrant,
  fileGrantEntries,
  grantedFileBytes,
  previewPageToken,
} from './assistant-file-grants.js';
import {
  preparePageBundle,
  referencedAssets,
  type PageSource,
} from '../capabilities/pages/bundle.js';
import { resourceKind } from '../capabilities/pages/resources.js';
import { publishMiniPage } from './assistant-pages.js';
import type { AssistantFileLimits } from './assistant-file-policy.js';
import { resourceUrl } from '../capabilities/pages/resources.js';

export function createFileGrantPreviews(
  db: Database,
  limits: AssistantFileLimits,
  chatId: string,
  ownerId: string,
  token: string,
  now = Date.now(),
) {
  const grant = fileGrant(db, token, now);
  if (!grant || grant.chat_id !== chatId)
    throw new Error('File grant not found in this chat.');
  const entries = fileGrantEntries(db, grant);
  const sources = new Map(
    entries
      .filter((entry) => resourceKind(entry.path))
      .map((entry) => [
        entry.path,
        {
          path: entry.path,
          content: grantedFileBytes(db, grant, entry.ordinal)!,
        },
      ]),
  );
  const result: { ordinal: number; id: string; url: string }[] = [];
  for (const entry of entries.filter(
    (file) => resourceKind(file.path) === 'html',
  )) {
    const source = sources.get(entry.path)!;
    const prepared = preparePageBundle(
      source,
      referencedAssets(source, sources),
      entry.filename,
      previewPageToken(token, entry.ordinal),
    );
    const page = publishMiniPage(
      db,
      limits,
      {
        chatId,
        ownerId,
        sourcePath: entry.path,
        title: entry.filename,
        html: prepared.html,
        assets: prepared.assets,
        token: prepared.token,
        hours: (grant.expires_at - now) / 3600_000,
      },
      now,
    );
    db.query(
      'INSERT INTO assistant_file_page_previews(token_hash,ordinal,page_id) VALUES (?,?,?)',
    ).run(grant.token_hash, entry.ordinal, page.id);
    result.push({
      ordinal: entry.ordinal,
      id: page.id,
      url: resourceUrl(page.token, entry.path),
    });
  }
  return result;
}

export function fileGrantPreviewOrdinals(
  db: Database,
  hash: string,
  now = Date.now(),
): Set<number> {
  return new Set(
    (
      db
        .query(
          'SELECT ordinal FROM assistant_file_page_previews AS preview JOIN assistant_mini_pages AS page ON page.id=preview.page_id WHERE preview.token_hash=? AND page.expires_at>?',
        )
        .all(hash, now) as { ordinal: number }[]
    ).map((row) => row.ordinal),
  );
}
