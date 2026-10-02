import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ASSISTANT_SCHEMA } from './assistant-schema.js';
import { ASSISTANT_CORE_SCHEMA } from './assistant-core-schema.js';
import { ASSISTANT_DELIVERY_SCHEMA } from './assistant-delivery-schema.js';
import { ASSISTANT_PAGE_SCHEMA } from './assistant-page-schema.js';
import { AssistantMemory } from './assistant-memory.js';
import { AssistantTodos } from './assistant-todos.js';
import { AssistantPromptJobs } from './assistant-prompt-jobs.js';
import { AssistantCompactionState } from './assistant-compaction.js';
import type {
  Actor,
  AssistantChat,
  AssistantJob,
  InboundRequest,
  LlmMessage,
  MeetingVote,
  TaskType,
  TaskUsage,
} from '../shared/assistant-types.js';

export class AssistantStore {
  readonly db: Database;
  readonly memory: AssistantMemory;
  readonly todos: AssistantTodos;
  readonly promptJobs: AssistantPromptJobs;
  readonly compaction: AssistantCompactionState;
  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file, { create: true });
    this.db.exec(ASSISTANT_SCHEMA);
    this.db.exec(ASSISTANT_CORE_SCHEMA);
    this.db.exec(ASSISTANT_DELIVERY_SCHEMA);
    this.db.exec(ASSISTANT_PAGE_SCHEMA);
    this.memory = new AssistantMemory(this.db);
    this.todos = new AssistantTodos(this.db);
    this.promptJobs = new AssistantPromptJobs(this.db, this);
    this.memory.seedHistory();
    this.compaction = new AssistantCompactionState(this.db);
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  state(key: string): string | undefined {
    return (
      this.db
        .query('SELECT value FROM assistant_state WHERE key=?')
        .get(key) as { value: string } | null
    )?.value;
  }
  setState(key: string, value: string): void {
    this.db
      .query('INSERT OR REPLACE INTO assistant_state VALUES (?,?)')
      .run(key, value);
  }
  chat(id: string): AssistantChat | null {
    return this.db
      .query('SELECT * FROM assistant_chats WHERE id=?')
      .get(id) as AssistantChat | null;
  }
  saveChat(chat: AssistantChat): void {
    this.db
      .query(
        `INSERT INTO assistant_chats VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      type=excluded.type, timezone=excluded.timezone, active=excluded.active`,
      )
      .run(chat.id, chat.type, chat.timezone, chat.active);
  }
  enqueue(request: InboundRequest): void {
    request.contextVersion ??= this.contextVersion(request.chat.id);
    const inserted = this.db
      .query('INSERT OR IGNORE INTO assistant_inbox(id,request) VALUES (?,?)')
      .run(request.updateId, JSON.stringify(request));
    if (!request.scheduled && inserted.changes)
      this.compaction.activity(request.chat.id);
  }
  nextRequest(): InboundRequest | undefined {
    const row = this.db
      .query(
        "SELECT request FROM assistant_inbox WHERE status='pending' ORDER BY id LIMIT 1",
      )
      .get() as { request: string } | null;
    return row ? (JSON.parse(row.request) as InboundRequest) : undefined;
  }
  requestStatus(id: number, status: string): void {
    this.db
      .query(
        "UPDATE assistant_inbox SET status=?,request=CASE WHEN ?='done' THEN '{}' ELSE request END WHERE id=?",
      )
      .run(status, status, id);
  }
  contextVersion(chatId: string): number {
    return Number(this.state(`context_version:${chatId}`) || 0);
  }
  remember(
    chatId: string,
    role: 'user' | 'assistant',
    content: string,
    recordedAt?: string,
  ): void {
    this.transaction(() => {
      const inserted = this.db
        .query(
          'INSERT INTO assistant_history(chat_id,role,content) VALUES (?,?,?)',
        )
        .run(chatId, role, content);
      this.memory.archive(
        Number(inserted.lastInsertRowid),
        chatId,
        role,
        content,
        recordedAt,
      );
      this.compaction.changed(chatId, role === 'user');
    });
  }
  history(chatId: string): LlmMessage[] {
    return this.db
      .query(
        'SELECT role,content FROM assistant_history WHERE chat_id=? ORDER BY id',
      )
      .all(chatId) as LlmMessage[];
  }
  forget(chatId: string): void {
    this.transaction(() => {
      this.db
        .query('DELETE FROM assistant_history WHERE chat_id=?')
        .run(chatId);
      this.memory.clearContext(chatId);
      this.compaction.clear(chatId);
      this.setState(
        `context_version:${chatId}`,
        String(this.contextVersion(chatId) + 1),
      );
    });
  }
  job(id: string): AssistantJob | null {
    return this.db
      .query('SELECT * FROM assistant_jobs WHERE id=?')
      .get(id) as AssistantJob | null;
  }
  jobByOrigin(key: string): AssistantJob | null {
    return this.db
      .query('SELECT * FROM assistant_jobs WHERE origin_key=?')
      .get(key) as AssistantJob | null;
  }
  jobs(chatId: string): AssistantJob[] {
    return this.db
      .query(
        "SELECT * FROM assistant_jobs WHERE chat_id=? AND status IN ('active','delivering','delivery_failed') ORDER BY due_at",
      )
      .all(chatId) as AssistantJob[];
  }
  createJob(job: AssistantJob, origin: string): void {
    this.db
      .query(
        `INSERT INTO assistant_jobs(id,origin_key,chat_id,owner_id,kind,title,due_at,remind_at,data,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        job.id,
        origin,
        job.chat_id,
        job.owner_id,
        job.kind,
        job.title,
        job.due_at,
        job.remind_at,
        job.data,
        job.created_at,
      );
  }
  dueJobs(now: string): AssistantJob[] {
    return this.db
      .query(
        `SELECT * FROM assistant_jobs WHERE status='active' AND
      (due_at<=? OR (reminded=0 AND remind_at<=?))`,
      )
      .all(now, now) as AssistantJob[];
  }
  finishJob(id: string, status: AssistantJob['status']): void {
    this.db
      .query('UPDATE assistant_jobs SET status=? WHERE id=?')
      .run(status, id);
  }
  markReminded(id: string): void {
    this.db.query('UPDATE assistant_jobs SET reminded=1 WHERE id=?').run(id);
  }
  votes(id: string): MeetingVote[] {
    return this.db
      .query('SELECT * FROM assistant_votes WHERE job_id=?')
      .all(id) as MeetingVote[];
  }
  vote(id: string, actor: Actor, choices: number[]): void {
    this.db
      .query(
        `INSERT INTO assistant_votes VALUES (?,?,?,?,?) ON CONFLICT(job_id,user_id) DO UPDATE SET
      username=excluded.username,name=excluded.name,choices=excluded.choices`,
      )
      .run(
        id,
        actor.id,
        actor.username || null,
        actor.name,
        JSON.stringify(choices),
      );
  }
  send(id: string, chatId: string, text: string, markup?: unknown): void {
    this.db
      .query(
        'INSERT OR IGNORE INTO assistant_outbox(id,chat_id,text,markup,next_attempt) VALUES (?,?,?,?,?)',
      )
      .run(
        id,
        chatId,
        text,
        markup ? JSON.stringify(markup) : null,
        new Date().toISOString(),
      );
  }
  startRun(
    id: string,
    chat: AssistantChat,
    userId: string | null,
    type: TaskType,
  ): void {
    this.db
      .query(
        'INSERT OR IGNORE INTO assistant_runs(id,chat_id,user_id,task_type,started_at) VALUES (?,?,?,?,?)',
      )
      .run(id, chat.id, userId, type, new Date().toISOString());
  }
  setTaskType(id: string, type: TaskType): void {
    this.db
      .query('UPDATE assistant_runs SET task_type=? WHERE id=?')
      .run(type, id);
  }
  runUsage(id: string): TaskUsage {
    return this.db
      .query(
        'SELECT llm_calls,tokens_in,tokens_out,cost_usd FROM assistant_runs WHERE id=?',
      )
      .get(id) as TaskUsage;
  }
  addUsage(id: string, usage: TaskUsage): void {
    this.db
      .query(
        `UPDATE assistant_runs SET llm_calls=llm_calls+?,tokens_in=tokens_in+?,tokens_out=tokens_out+?,cost_usd=cost_usd+? WHERE id=?`,
      )
      .run(
        usage.llm_calls,
        usage.tokens_in,
        usage.tokens_out,
        usage.cost_usd,
        id,
      );
  }
  dailyCount(
    column: 'user_id' | 'chat_id',
    id: string,
    heavy = false,
    exclude = '',
  ): number {
    const since = new Date().toISOString().slice(0, 10);
    return (
      this.db
        .query(
          `SELECT COUNT(*) AS n FROM assistant_runs WHERE ${column}=? AND started_at>=? AND id!=?
      ${heavy ? 'AND used_search=1' : ''}`,
        )
        .get(id, since, exclude) as { n: number }
    ).n;
  }
  monthSpend(): number {
    return (
      this.db
        .query(
          'SELECT COALESCE(SUM(cost_usd),0) AS n FROM assistant_spend WHERE created_at>=?',
        )
        .get(new Date().toISOString().slice(0, 7)) as { n: number }
    ).n;
  }
  reserveSpend(id: string, cost: number): void {
    this.db
      .query('INSERT INTO assistant_spend VALUES (?,?,?)')
      .run(id, new Date().toISOString(), cost);
  }
  settleSpend(id: string, cost: number): void {
    this.db
      .query('UPDATE assistant_spend SET cost_usd=? WHERE id=?')
      .run(cost, id);
  }
  close(): void {
    this.db.close();
  }
}
