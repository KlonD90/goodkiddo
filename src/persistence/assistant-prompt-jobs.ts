import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { NotificationMode } from '../shared/assistant-types.js';
import {
  nextPromptRun,
  normalizePromptCron,
} from '../shared/prompt-schedule.js';
import type { AssistantStore } from './assistant-store.js';
import { discardRunDeliveries } from './assistant-delivery-links.js';

export interface PromptJobInput {
  title: string;
  prompt: string;
  cron: string;
  timezone: string;
  notification: NotificationMode;
  maxCalls: number;
  maxSearches: number;
  maxCostUsd: number;
}
export interface PromptJob extends PromptJobInput {
  id: string;
  chatId: string;
  ownerId: string;
  status: 'active' | 'paused' | 'cancelled';
  nextRun: string;
  lastRun: string | null;
  revision: number;
  failures: number;
}
export interface PromptRun {
  id: string;
  job_id: string;
  due_at: string;
  revision: number;
  status: string;
  result: string | null;
  started_at: string;
  finished_at: string | null;
}
const SELECT = `SELECT id,chat_id AS chatId,owner_id AS ownerId,title,prompt,cron,timezone,notification,status,
  next_run AS nextRun,last_run AS lastRun,revision,failures,max_calls AS maxCalls,max_searches AS maxSearches,max_cost_usd AS maxCostUsd FROM assistant_prompt_jobs`;

export class AssistantPromptJobs {
  constructor(
    private readonly db: Database,
    private readonly store: AssistantStore,
  ) {}
  get(id: string): PromptJob | null {
    return this.db.query(`${SELECT} WHERE id=?`).get(id) as PromptJob | null;
  }
  list(chatId: string): PromptJob[] {
    return this.db
      .query(
        `${SELECT} WHERE chat_id=? AND status!='cancelled' ORDER BY next_run,id`,
      )
      .all(chatId) as PromptJob[];
  }
  create(
    chatId: string,
    ownerId: string,
    input: PromptJobInput,
    origin: string,
    maxJobs: number,
    now = new Date(),
  ): PromptJob {
    return this.store.transaction(() => {
      const existing = this.db
        .query(
          'SELECT id FROM assistant_prompt_jobs WHERE origin_key=? AND chat_id=?',
        )
        .get(origin, chatId) as { id: string } | null;
      if (existing) return this.get(existing.id)!;
      validateInput(input);
      if (this.list(chatId).length + this.store.jobs(chatId).length >= maxJobs)
        throw new Error(
          'В чате уже слишком много сохранённых задач. Отмените ненужные.',
        );
      const cron = normalizePromptCron(input.cron);
      const id = `prompt-${randomUUID().slice(0, 12)}`;
      this.db
        .query(
          `INSERT INTO assistant_prompt_jobs(id,origin_key,chat_id,owner_id,title,prompt,cron,timezone,notification,next_run,max_calls,max_searches,max_cost_usd,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          origin,
          chatId,
          ownerId,
          input.title.trim(),
          input.prompt.trim(),
          cron,
          input.timezone,
          input.notification,
          nextPromptRun(cron, input.timezone, now),
          input.maxCalls,
          input.maxSearches,
          input.maxCostUsd,
          now.toISOString(),
          now.toISOString(),
        );
      return this.get(id)!;
    });
  }
  update(
    chatId: string,
    ownerId: string,
    id: string,
    change: Partial<PromptJobInput> & { status?: PromptJob['status'] },
    now = new Date(),
  ): PromptJob {
    return this.store.transaction(() => {
      const job = this.owned(chatId, ownerId, id);
      if (job.status === 'cancelled')
        throw new Error('Задача отменена. Создайте новую.');
      const edited = { ...job, ...change };
      validateInput(edited);
      const cron = normalizePromptCron(edited.cron);
      const next = nextPromptRun(cron, edited.timezone, now);
      // Editing/pausing invalidates claimed runs and queued notifications, but preserves saved results.
      const runs = this.db
        .query(
          "SELECT id FROM assistant_prompt_runs WHERE job_id=? AND status IN ('claimed','running','awaiting_delivery')",
        )
        .all(id) as { id: string }[];
      for (const run of runs) {
        discardRunDeliveries(this.store, run.id);
        this.db
          .query(
            "UPDATE assistant_prompt_runs SET status='cancelled',finished_at=? WHERE id=?",
          )
          .run(now.toISOString(), run.id);
        this.db
          .query(
            "UPDATE assistant_runs SET status='cancelled',finished_at=? WHERE id=? AND status='running'",
          )
          .run(now.toISOString(), run.id);
      }
      this.db
        .query(
          `UPDATE assistant_prompt_jobs SET title=?,prompt=?,cron=?,timezone=?,notification=?,status=?,next_run=?,revision=revision+1,failures=0,max_calls=?,max_searches=?,max_cost_usd=?,updated_at=? WHERE id=?`,
        )
        .run(
          edited.title.trim(),
          edited.prompt.trim(),
          cron,
          edited.timezone,
          edited.notification,
          edited.status,
          next,
          edited.maxCalls,
          edited.maxSearches,
          edited.maxCostUsd,
          now.toISOString(),
          id,
        );
      return this.get(id)!;
    });
  }
  claim(now = new Date()): { job: PromptJob; runId: string } | undefined {
    return this.store.transaction(() => {
      const row = this.db
        .query(
          `SELECT j.id FROM assistant_prompt_jobs j JOIN assistant_chats c ON c.id=j.chat_id
        WHERE j.status='active' AND c.active=1 AND j.next_run<=? ORDER BY j.next_run,j.id LIMIT 1`,
        )
        .get(now.toISOString()) as { id: string } | null;
      if (!row) return;
      const job = this.get(row.id)!;
      const runId = `prompt-run:${createHash('sha256')
        .update(job.id + ':' + job.nextRun)
        .digest('hex')
        .slice(0, 24)}`;
      const inserted = this.db
        .query(
          "INSERT OR IGNORE INTO assistant_prompt_runs(id,job_id,due_at,revision,status,started_at) VALUES (?,?,?,?,'claimed',?)",
        )
        .run(runId, job.id, job.nextRun, job.revision, now.toISOString());
      // Advance from now rather than replaying every missed occurrence after downtime.
      this.db
        .query(
          'UPDATE assistant_prompt_jobs SET next_run=?,last_run=?,updated_at=? WHERE id=?',
        )
        .run(
          nextPromptRun(job.cron, job.timezone, now),
          now.toISOString(),
          now.toISOString(),
          job.id,
        );
      return inserted.changes ? { job, runId } : undefined;
    });
  }
  isCurrent(jobId: string, revision: number): boolean {
    const job = this.get(jobId);
    return !!job && job.status === 'active' && job.revision === revision;
  }
  startRun(id: string): void {
    this.db
      .query(
        "UPDATE assistant_prompt_runs SET status='running' WHERE id=? AND status='claimed'",
      )
      .run(id);
  }
  result(chatId: string, runId: string): PromptRun {
    const result = this.db
      .query(
        `SELECT r.* FROM assistant_prompt_runs r JOIN assistant_prompt_jobs j ON j.id=r.job_id WHERE r.id=? AND j.chat_id=?`,
      )
      .get(runId, chatId) as PromptRun | null;
    if (!result) throw new Error('Результат не найден в этом чате.');
    return result;
  }
  runs(chatId: string, id: string): PromptRun[] {
    if (this.get(id)?.chatId !== chatId)
      throw new Error('Задача не найдена в этом чате.');
    return this.db
      .query(
        'SELECT * FROM assistant_prompt_runs WHERE job_id=? ORDER BY started_at DESC,id DESC LIMIT 20',
      )
      .all(id) as PromptRun[];
  }
  finish(id: string, status: string, result: string, queued: boolean): void {
    this.store.transaction(() => {
      const run = this.db
        .query('SELECT * FROM assistant_prompt_runs WHERE id=?')
        .get(id) as PromptRun | null;
      if (!run || (run.status !== 'running' && run.status !== 'claimed'))
        return;
      this.db
        .query(
          'UPDATE assistant_prompt_runs SET status=?,outcome=?,result=?,finished_at=? WHERE id=?',
        )
        .run(
          queued ? 'awaiting_delivery' : status,
          status,
          result.slice(0, 48000),
          new Date().toISOString(),
          id,
        );
      if (status === 'cancelled') return;
      this.db
        .query(
          `UPDATE assistant_prompt_jobs SET failures=CASE WHEN ?='success' THEN 0 ELSE failures+1 END,
        status=CASE WHEN ?!='success' AND failures>=2 THEN 'paused' ELSE status END WHERE id=?`,
        )
        .run(status, status, run.job_id);
    });
  }
  finishDelivery(id: string, status: 'success' | 'error' | 'cancelled'): void {
    this.db
      .query(
        "UPDATE assistant_prompt_runs SET status=CASE WHEN ?='success' THEN COALESCE(outcome,'success') ELSE ? END,finished_at=? WHERE id=? AND status='awaiting_delivery'",
      )
      .run(
        status,
        status === 'error' ? 'delivery_failed' : 'cancelled',
        new Date().toISOString(),
        id,
      );
  }
  private owned(chatId: string, ownerId: string, id: string): PromptJob {
    const job = this.get(id);
    if (!job || job.chatId !== chatId)
      throw new Error('Задача не найдена в этом чате.');
    if (job.ownerId !== ownerId)
      throw new Error('Изменить задачу может её создатель.');
    return job;
  }
}
function validateInput(input: PromptJobInput): void {
  if (
    !input.title.trim() ||
    input.title.length > 200 ||
    !input.prompt.trim() ||
    input.prompt.length > 10000
  )
    throw new Error('Нужны название до 200 и поручение до 10000 символов.');
  if (
    !['verbose', 'summary', 'errors_only', 'silent'].includes(
      input.notification,
    )
  )
    throw new Error('Неизвестный режим уведомлений.');
  if (
    !Number.isInteger(input.maxCalls) ||
    input.maxCalls < 1 ||
    input.maxCalls > 6 ||
    !Number.isInteger(input.maxSearches) ||
    input.maxSearches < 0 ||
    input.maxSearches > 3 ||
    !Number.isFinite(input.maxCostUsd) ||
    input.maxCostUsd < 0 ||
    input.maxCostUsd > 1
  )
    throw new Error(
      'Лимиты задания: 1–6 LLM-шагов, 0–3 поиска, 0–1 USD за запуск; общие лимиты также действуют.',
    );
  nextPromptRun(input.cron, input.timezone, new Date());
}
