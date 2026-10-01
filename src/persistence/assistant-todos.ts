import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

export interface AssistantTodo {
  id: string;
  chat_id: string;
  owner_id: string;
  title: string;
  status: 'open' | 'done' | 'dismissed';
  created_at: string;
  updated_at: string;
}

export class AssistantTodos {
  constructor(private readonly db: Database) {}
  list(
    chatId: string,
    status: AssistantTodo['status'] | 'all' = 'open',
  ): AssistantTodo[] {
    return this.db
      .query(
        `SELECT id,chat_id,owner_id,title,status,created_at,updated_at FROM assistant_todos
      WHERE chat_id=? ${status === 'all' ? '' : 'AND status=?'} ORDER BY created_at,id LIMIT 200`,
      )
      .all(
        ...(status === 'all' ? [chatId] : [chatId, status]),
      ) as AssistantTodo[];
  }
  add(
    chatId: string,
    ownerId: string,
    title: string,
    origin: string,
  ): AssistantTodo {
    const existing = this.db
      .query('SELECT * FROM assistant_todos WHERE origin_key=? AND chat_id=?')
      .get(origin, chatId) as AssistantTodo | null;
    if (existing) return existing;
    validateTitle(title);
    if (this.list(chatId).length >= 200)
      throw new Error('В чате уже 200 открытых дел.');
    const id = `todo-${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    this.db
      .query('INSERT INTO assistant_todos VALUES (?,?,?,?,?,?,?,?)')
      .run(id, origin, chatId, ownerId, title.trim(), 'open', now, now);
    return this.getOwned(chatId, ownerId, id);
  }
  update(
    chatId: string,
    ownerId: string,
    id: string,
    change: { title?: string; status?: AssistantTodo['status'] },
  ): AssistantTodo {
    const todo = this.getOwned(chatId, ownerId, id);
    if (change.title !== undefined) validateTitle(change.title);
    this.db
      .query(
        'UPDATE assistant_todos SET title=?,status=?,updated_at=? WHERE id=? AND chat_id=?',
      )
      .run(
        change.title?.trim() ?? todo.title,
        change.status ?? todo.status,
        new Date().toISOString(),
        id,
        chatId,
      );
    return this.getOwned(chatId, ownerId, id);
  }
  private getOwned(chatId: string, ownerId: string, id: string): AssistantTodo {
    const todo = this.db
      .query('SELECT * FROM assistant_todos WHERE chat_id=? AND id=?')
      .get(chatId, id) as AssistantTodo | null;
    if (!todo) throw new Error('Дело не найдено в этом чате.');
    if (todo.owner_id !== ownerId)
      throw new Error('Изменить дело может его создатель.');
    return todo;
  }
}
function validateTitle(title: string): void {
  if (!title.trim() || title.length > 2000)
    throw new Error('Нужен текст дела до 2000 символов.');
}
