import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { LlmMessage } from '../shared/assistant-types.js';

export const IDLE_COMPACTION_MS = 60 * 60 * 1000;
export type CompactionTrigger = 'idle' | 'pressure';
export interface CompactionSnapshot {
  chatId: string;
  generation: number;
  token: string;
  cutoff: number;
  summary: string;
  rows: (LlmMessage & { id: number })[];
}
export class AssistantCompactionState {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_compaction (
      chat_id TEXT PRIMARY KEY, last_user_at INTEGER, generation INTEGER NOT NULL DEFAULT 0,
      attempted_generation INTEGER NOT NULL DEFAULT -1, claim_token TEXT,
      status TEXT NOT NULL DEFAULT 'pending', updated_at INTEGER NOT NULL
      , trigger TEXT NOT NULL DEFAULT 'idle'
    );`);
    const columns = db
      .query('PRAGMA table_info(assistant_compaction)')
      .all() as { name: string }[];
    if (!columns.some((column) => column.name === 'trigger'))
      db.exec(
        "ALTER TABLE assistant_compaction ADD COLUMN trigger TEXT NOT NULL DEFAULT 'idle'",
      );
    // On first upgrade restore complete archived sources instead of trusting the
    // legacy first-800-character digest. Persisted compaction state prevents
    // re-expanding already compacted chats on every restart.
    db.query(
      `INSERT OR IGNORE INTO assistant_history(id,chat_id,role,content)
      SELECT id,chat_id,role,content FROM assistant_history_archive
      WHERE chat_id NOT IN (SELECT chat_id FROM assistant_compaction)`,
    ).run();
    // Upgrade retained history without guessing recent user activity. A restart
    // never replays an ambiguous in-flight call for the same generation.
    db.query(
      `INSERT OR IGNORE INTO assistant_compaction(chat_id,last_user_at,updated_at)
      SELECT chat_id,?,? FROM assistant_history GROUP BY chat_id`,
    ).run(Date.now(), Date.now());
  }
  activity(chatId: string, now = Date.now()): void {
    this.db
      .query(
        `INSERT INTO assistant_compaction(chat_id,last_user_at,updated_at) VALUES (?,?,?)
      ON CONFLICT(chat_id) DO UPDATE SET last_user_at=excluded.last_user_at,
      generation=generation+1,updated_at=excluded.updated_at`,
      )
      .run(chatId, now, now);
  }
  changed(chatId: string, user: boolean): void {
    this.db
      .query(
        `INSERT INTO assistant_compaction(chat_id,last_user_at,generation,updated_at) VALUES (?,?,1,?)
      ON CONFLICT(chat_id) DO UPDATE SET generation=generation+1,updated_at=excluded.updated_at,
      last_user_at=COALESCE(last_user_at,excluded.last_user_at)`,
      )
      .run(chatId, user ? Date.now() : null, Date.now());
  }
  due(now = Date.now()): string[] {
    return (
      this.db
        .query(
          `SELECT c.chat_id FROM assistant_compaction c
      JOIN assistant_chats chat ON chat.id=c.chat_id AND chat.active=1
      WHERE c.last_user_at<=? AND c.generation!=c.attempted_generation
      AND c.claim_token IS NULL
      AND EXISTS (SELECT 1 FROM assistant_history h WHERE h.chat_id=c.chat_id)
      AND NOT EXISTS (SELECT 1 FROM assistant_inbox i WHERE i.status IN ('pending','processing')
        AND json_extract(i.request,'$.chat.id')=c.chat_id)
      ORDER BY c.last_user_at,c.chat_id`,
        )
        .all(now - IDLE_COMPACTION_MS) as { chat_id: string }[]
    ).map((r) => r.chat_id);
  }
  status(
    chatId: string,
  ): { status: string; trigger: CompactionTrigger } | undefined {
    return this.db
      .query('SELECT status,trigger FROM assistant_compaction WHERE chat_id=?')
      .get(chatId) as
      | { status: string; trigger: CompactionTrigger }
      | undefined;
  }
  claim(
    chatId: string,
    now = Date.now(),
    trigger: CompactionTrigger = 'idle',
  ): CompactionSnapshot | undefined {
    return this.db.transaction(() => {
      const eligible =
        trigger === 'idle'
          ? this.due(now).includes(chatId)
          : !!this.db
              .query(
                `SELECT c.chat_id FROM assistant_compaction c
         JOIN assistant_chats chat ON chat.id=c.chat_id AND chat.active=1
         WHERE c.chat_id=? AND c.generation!=c.attempted_generation AND c.claim_token IS NULL
         AND EXISTS (SELECT 1 FROM assistant_history h WHERE h.chat_id=c.chat_id)`,
              )
              .get(chatId);
      if (!eligible) return undefined;
      const token = randomUUID();
      const row = this.db
        .query('SELECT generation FROM assistant_compaction WHERE chat_id=?')
        .get(chatId) as { generation: number };
      this.db
        .query(
          `UPDATE assistant_compaction SET attempted_generation=generation,
        claim_token=?,status='running',updated_at=?,trigger=? WHERE chat_id=?`,
        )
        .run(token, now, trigger, chatId);
      const rows = this.db
        .query(
          'SELECT id,role,content FROM assistant_history WHERE chat_id=? ORDER BY id',
        )
        .all(chatId) as CompactionSnapshot['rows'];
      const summary =
        (
          this.db
            .query(
              'SELECT content FROM assistant_context_summaries WHERE chat_id=?',
            )
            .get(chatId) as { content: string } | null
        )?.content ?? '';
      return {
        chatId,
        token,
        generation: row.generation,
        cutoff: rows.at(-1)!.id,
        rows,
        summary,
      };
    })();
  }
  current(snapshot: CompactionSnapshot): boolean {
    const state = this.db
      .query(
        'SELECT generation,claim_token FROM assistant_compaction c JOIN assistant_chats chat ON chat.id=c.chat_id AND chat.active=1 WHERE chat_id=?',
      )
      .get(snapshot.chatId) as {
      generation: number;
      claim_token: string;
    } | null;
    const summary =
      (
        this.db
          .query(
            'SELECT content FROM assistant_context_summaries WHERE chat_id=?',
          )
          .get(snapshot.chatId) as { content: string } | null
      )?.content ?? '';
    return (
      state?.generation === snapshot.generation &&
      state.claim_token === snapshot.token &&
      summary === snapshot.summary
    );
  }
  commit(snapshot: CompactionSnapshot, summary: string): boolean {
    return this.db.transaction(() => {
      if (!this.current(snapshot)) return false;
      this.db
        .query(
          'INSERT OR REPLACE INTO assistant_context_summaries VALUES (?,?,?)',
        )
        .run(snapshot.chatId, summary, new Date().toISOString());
      this.db
        .query('DELETE FROM assistant_history WHERE chat_id=? AND id<=?')
        .run(snapshot.chatId, snapshot.cutoff);
      this.finish(snapshot, 'success');
      return true;
    })();
  }
  finish(snapshot: CompactionSnapshot, status: string): void {
    this.db
      .query(
        'UPDATE assistant_compaction SET status=?,claim_token=NULL,updated_at=? WHERE chat_id=? AND claim_token=?',
      )
      .run(status, Date.now(), snapshot.chatId, snapshot.token);
  }
  recover(): void {
    this.db
      .query(
        "UPDATE assistant_compaction SET status='interrupted',claim_token=NULL WHERE status='running'",
      )
      .run();
  }
  clear(chatId: string): void {
    this.db
      .query('DELETE FROM assistant_compaction WHERE chat_id=?')
      .run(chatId);
  }
}
