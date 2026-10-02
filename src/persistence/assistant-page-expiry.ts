import type { Database } from 'bun:sqlite';

export function expireMiniPages(db: Database, now = Date.now()): void {
  db.query('DELETE FROM assistant_mini_pages WHERE expires_at<=?').run(now);
}
