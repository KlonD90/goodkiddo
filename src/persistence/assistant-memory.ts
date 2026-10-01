import type { Database } from 'bun:sqlite';

export interface ChatMemory {
  key: string;
  owner_id: string;
  kind: 'fact' | 'preference' | 'skill';
  content: string;
  updated_at: string;
}
export interface ArchivedMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  recorded_at: string;
}

export class AssistantMemory {
  constructor(private readonly db: Database) {}

  // Seed the currently retained window once; never import a legacy/private database.
  seedHistory(): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO assistant_history_archive
      SELECT id,chat_id,role,content,? FROM assistant_history`,
      )
      .run(new Date().toISOString());
  }

  archive(
    id: number,
    chatId: string,
    role: string,
    content: string,
    recordedAt = new Date().toISOString(),
  ): void {
    this.db
      .query(
        'INSERT OR IGNORE INTO assistant_history_archive VALUES (?,?,?,?,?)',
      )
      .run(id, chatId, role, content, recordedAt);
  }

  summarizeEvicted(chatId: string): void {
    const evicted = this.db
      .query(
        `SELECT id,role,content FROM assistant_history WHERE chat_id=? AND id NOT IN
      (SELECT id FROM assistant_history WHERE chat_id=? ORDER BY id DESC LIMIT 24) ORDER BY id`,
      )
      .all(chatId, chatId) as { id: number; role: string; content: string }[];
    if (!evicted.length) return;
    // Extractive digest has no extra provider calls/cost. Full older messages remain searchable.
    const additions = evicted
      .map((row) => `[${row.id} ${row.role}] ${row.content.slice(0, 800)}`)
      .join('\n');
    this.setSummary(
      chatId,
      [this.summary(chatId), additions]
        .filter(Boolean)
        .join('\n')
        .slice(-16000),
    );
  }

  summary(chatId: string): string {
    return (
      (
        this.db
          .query(
            'SELECT content FROM assistant_context_summaries WHERE chat_id=?',
          )
          .get(chatId) as { content: string } | null
      )?.content || ''
    );
  }

  setSummary(chatId: string, content: string): void {
    if (content.length > 16000)
      throw new Error('Сводка превышает 16000 символов.');
    this.db
      .query(
        'INSERT OR REPLACE INTO assistant_context_summaries VALUES (?,?,?)',
      )
      .run(chatId, content, new Date().toISOString());
  }

  list(chatId: string): ChatMemory[] {
    return this.db
      .query(
        'SELECT key,owner_id,kind,content,updated_at FROM assistant_memories WHERE chat_id=? ORDER BY key',
      )
      .all(chatId) as ChatMemory[];
  }

  write(
    chatId: string,
    ownerId: string,
    key: string,
    content: string,
    kind: ChatMemory['kind'],
  ): void {
    if (
      !key.trim() ||
      key.length > 100 ||
      !content.trim() ||
      content.length > 4000
    )
      throw new Error('Нужны ключ до 100 и запись до 4000 символов.');
    const existing = this.list(chatId).find((note) => note.key === key);
    if (existing && existing.owner_id !== ownerId)
      throw new Error('Изменить запись может её автор.');
    if (!existing && this.list(chatId).length >= 100)
      throw new Error('В чате уже 100 записей памяти.');
    this.db
      .query(
        `INSERT INTO assistant_memories VALUES (?,?,?,?,?,?) ON CONFLICT(chat_id,key)
      DO UPDATE SET content=excluded.content,kind=excluded.kind,updated_at=excluded.updated_at`,
      )
      .run(chatId, key, ownerId, kind, content, new Date().toISOString());
  }

  remove(chatId: string, ownerId: string, key: string): void {
    const existing = this.list(chatId).find((note) => note.key === key);
    if (!existing) throw new Error('Запись не найдена в этом чате.');
    if (existing.owner_id !== ownerId)
      throw new Error('Удалить запись может её автор.');
    this.db
      .query('DELETE FROM assistant_memories WHERE chat_id=? AND key=?')
      .run(chatId, key);
  }

  search(chatId: string, query: string, limit = 10): ArchivedMessage[] {
    if (!query.trim()) throw new Error('Нужен текст для поиска.');
    const escaped = query
      .slice(0, 200)
      .replace(/[\\%_]/g, (value) => `\\${value}`);
    return this.db
      .query(
        `SELECT id,role,content,recorded_at FROM assistant_history_archive
      WHERE chat_id=? AND content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`,
      )
      .all(
        chatId,
        `%${escaped}%`,
        Math.max(1, Math.min(20, limit)),
      ) as ArchivedMessage[];
  }

  clearContext(chatId: string): void {
    this.db
      .query('DELETE FROM assistant_history_archive WHERE chat_id=?')
      .run(chatId);
    this.db
      .query('DELETE FROM assistant_context_summaries WHERE chat_id=?')
      .run(chatId);
  }
}
