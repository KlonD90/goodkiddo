import type { Database } from 'bun:sqlite';

export function expireMiniPages(db: Database, now = Date.now()): void {
  db.transaction(() => {
    db.query(
      'DELETE FROM assistant_file_page_previews WHERE page_id NOT IN (SELECT id FROM assistant_mini_pages) OR page_id IN (SELECT id FROM assistant_mini_pages WHERE expires_at<=?)',
    ).run(now);
    db.query(
      'DELETE FROM assistant_mini_page_assets WHERE page_id NOT IN (SELECT id FROM assistant_mini_pages) OR page_id IN (SELECT id FROM assistant_mini_pages WHERE expires_at<=?)',
    ).run(now);
    db.query('DELETE FROM assistant_mini_pages WHERE expires_at<=?').run(now);
  })();
}
