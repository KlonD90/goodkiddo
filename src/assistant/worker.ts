import { createHash } from 'node:crypto';
import type { AssistantConfig } from '../config/assistant-config.js';
import type { AssistantStore } from '../persistence/assistant-store.js';
import type { AssistantAnalytics } from '../integrations/assistant-analytics.js';
import {
  LlmRequestError,
  type AssistantLlm,
} from '../providers/assistant-llm.js';
import type { TelegramAssistantApi } from '../channels/telegram-assistant-api.js';
import type { InboundRequest, TaskStatus } from '../shared/assistant-types.js';
import { AssistantTurnLimit, runAssistant } from './agent.js';
import { BudgetExceeded, enforceDailyLimits } from './budget.js';
import { enqueueReply } from './messages.js';
import {
  assertCurrentContext,
  ContextCleared,
  registerContextTurn,
} from './context.js';
import { TelegramTurnPreview } from '../channels/telegram-turn-preview.js';
import { ContextBudgetError } from '../providers/assistant-context-budget.js';
import { compactIdleChat } from './idle-compaction.js';
import { ensureTextDeliverySchema } from '../persistence/assistant-text-outbox.js';
import {
  assertScheduledTurn,
  claimPromptRequest,
  finishPromptTurn,
  recoverPromptTurns,
} from '../tasks/assistant-prompt-scheduler.js';

export class AssistantWorker {
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly controller = new AbortController();
  constructor(
    private readonly config: AssistantConfig,
    private readonly store: AssistantStore,
    private readonly analytics: AssistantAnalytics,
    private readonly llm: AssistantLlm,
    private readonly api: TelegramAssistantApi,
    private readonly browser?: import('./browser-runtime.js').BrowserResearchRuntime,
  ) {
    ensureTextDeliverySchema(store);
  }
  wake(): void {
    if (this.running || this.stopped) return;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    this.running.catch(() => {});
  }
  async idle(): Promise<void> {
    await this.running;
  }
  private async drain(): Promise<void> {
    let request: InboundRequest | undefined;
    while (
      !this.stopped &&
      (request =
        this.store.nextRequest() || claimPromptRequest(this.store, this.config))
    )
      await this.process(request);
    for (const chatId of this.store.compaction.due()) {
      if (this.stopped || this.store.nextRequest()) break;
      await compactIdleChat({
        config: this.config,
        store: this.store,
        analytics: this.analytics,
        llm: this.llm,
        chatId,
        signal: this.controller.signal,
      });
    }
  }
  private async process(request: InboundRequest): Promise<void> {
    const { store, analytics, config } = this;
    const chat = store.chat(request.chat.id);
    if (
      !chat?.active ||
      (request.contextVersion !== undefined &&
        request.contextVersion !== store.contextVersion(chat.id))
    ) {
      if (!request.scheduled) store.requestStatus(request.updateId, 'done');
      else
        store.promptJobs.finish(
          request.scheduled.runId,
          'cancelled',
          'Контекст очищен или чат недоступен.',
          false,
        );
      return;
    }
    request.chat = chat;
    request.contextVersion ??= store.contextVersion(chat.id);
    const contextTurn = registerContextTurn(store, chat.id);
    const taskId =
      request.scheduled?.runId ||
      `task-${createHash('sha256').update(`telegram-update:${request.updateId}`).digest('hex').slice(0, 24)}`;
    let status: TaskStatus = 'error';
    let errorType: string | undefined;
    let awaitingDelivery = false;
    store.transaction(() => {
      if (!request.scheduled)
        store.requestStatus(request.updateId, 'processing');
      else store.promptJobs.startRun(taskId);
      analytics.start(
        taskId,
        chat,
        request.actor.id,
        'other',
        request.scheduled ? 'bot' : 'user',
      );
      // Keep documents/notifications behind the active turn, including scheduled ones.
      store.setState(`delivery_hold:${taskId}`, '1');
    });
    const typing = setInterval(() => {
      if (request.scheduled) return;
      void this.api.typing(chat.id).catch(() => {});
    }, 4500);
    const preview = new TelegramTurnPreview(store, this.api, {
      taskId,
      chatId: chat.id,
      chatType: chat.type,
      draftId: request.updateId || 1,
      threadId: request.messageThreadId,
    });
    const stopPreview = () => {
      void preview.close().catch(() => {});
    };
    contextTurn.signal.addEventListener('abort', stopPreview, { once: true });
    try {
      enforceDailyLimits(store, config, request, false, taskId);
      if (!request.scheduled)
        store.remember(
          chat.id,
          'user',
          `${request.actor.name}: ${request.text}`,
          request.messageAt || request.messageDate,
        );
      if (!request.scheduled) await this.api.typing(chat.id).catch(() => {});
      const text = await runAssistant({
        config: request.scheduled
          ? {
              ...config,
              maxCalls: request.scheduled.maxCalls,
              maxSearches: request.scheduled.maxSearches,
            }
          : config,
        store,
        analytics,
        llm: this.llm,
        browser: this.browser,
        request,
        taskId,
        // Notification modes control what is published; do not stream scheduled results early.
        onContent: request.scheduled ? undefined : preview.update,
        signal: AbortSignal.any([
          this.controller.signal,
          contextTurn.signal,
          AbortSignal.timeout(180_000),
        ]),
      });
      const target = await preview.close();
      assertCurrentContext(store, request);
      assertScheduledTurn(store, request);
      store.transaction(() => {
        if (request.scheduled) {
          awaitingDelivery = finishPromptTurn(store, request, text, 'success');
          return;
        }
        store.remember(chat.id, 'assistant', text);
        const deliveries = enqueueReply(
          store,
          `reply:${taskId}`,
          chat.id,
          text,
          { ...target, runId: taskId, ownerId: request.actor.id },
        );
        for (const id of deliveries)
          store.setState(`delivery_run:${id}`, taskId);
      });
      if (!request.scheduled) awaitingDelivery = true;
      status = 'success';
    } catch (error) {
      const target = await preview.close();
      if (
        error instanceof ContextCleared ||
        request.contextVersion !== store.contextVersion(chat.id)
      ) {
        status = 'cancelled';
        errorType = 'internal';
        if (request.scheduled)
          store.promptJobs.finish(
            taskId,
            'cancelled',
            'Запуск отменён.',
            false,
          );
      } else {
        const result = describeFailure(error, this.stopped);
        status = result.status;
        errorType = result.errorType;
        store.transaction(() => {
          if (request.scheduled) {
            finishPromptTurn(store, request, result.message, status);
            return;
          }
          enqueueReply(store, `failure:${taskId}`, chat.id, result.message, {
            ...target,
            ownerId: request.actor.id,
          });
          store.remember(chat.id, 'assistant', result.message);
        });
      }
    } finally {
      await preview.close();
      clearInterval(typing);
      contextTurn.signal.removeEventListener('abort', stopPreview);
      contextTurn.release();
      store.transaction(() => {
        if (!request.scheduled) store.requestStatus(request.updateId, 'done');
        store.db
          .query('DELETE FROM assistant_state WHERE key=?')
          .run(`delivery_hold:${taskId}`);
        if (!awaitingDelivery)
          analytics.finish(taskId, chat, request.actor.id, status, errorType);
      });
    }
  }
  recoverInterrupted(): void {
    this.store.compaction.recover();
    const rows = this.store.db
      .query(
        `SELECT id,chat_id,user_id FROM assistant_runs WHERE status='running' AND (id NOT IN
      (SELECT value FROM assistant_state WHERE key LIKE 'delivery_run:%') OR EXISTS
      (SELECT 1 FROM assistant_state WHERE key='delivery_hold:'||assistant_runs.id))`,
      )
      .all() as { id: string; chat_id: string; user_id: string | null }[];
    this.store.transaction(() => {
      for (const row of rows) {
        if (row.id.startsWith('prompt-run:')) continue;
        if (row.id.startsWith('context-compaction:')) {
          this.analytics.finish(
            row.id,
            this.store.chat(row.chat_id)!,
            null,
            'cancelled',
            'internal',
          );
          continue;
        }
        const chat = this.store.chat(row.chat_id);
        if (!chat) continue;
        this.analytics.finish(
          row.id,
          chat,
          row.user_id,
          'cancelled',
          'internal',
        );
        const message =
          'Обработка поручения прервалась при перезапуске. Уже сохранённые напоминания и встречи остались в /tasks. Остальную часть поручения можно отправить снова.';
        const preview = this.store.db
          .query(
            'SELECT message_id,thread_id FROM assistant_reply_previews WHERE run_id=? AND chat_id=?',
          )
          .get(row.id, chat.id) as {
          message_id: number | null;
          thread_id: number | null;
        } | null;
        enqueueReply(this.store, `recovery:${row.id}`, chat.id, message, {
          messageId: preview?.message_id ?? undefined,
          threadId: preview?.thread_id ?? undefined,
        });
        this.store.remember(chat.id, 'assistant', message);
      }
      this.store.db
        .query(
          "UPDATE assistant_inbox SET status='done',request='{}' WHERE status='processing'",
        )
        .run();
      this.store.db
        .query("DELETE FROM assistant_state WHERE key LIKE 'delivery_hold:%'")
        .run();
      recoverPromptTurns(this.store, this.config, this.analytics);
    });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    await this.running;
  }
}
function describeFailure(
  error: unknown,
  stopped: boolean,
): { status: TaskStatus; errorType: string; message: string } {
  if (stopped)
    return {
      status: 'cancelled',
      errorType: 'internal',
      message:
        'Обработка остановлена. Уже сохранённые задачи остаются в /tasks.',
    };
  if (error instanceof BudgetExceeded || error instanceof ContextBudgetError)
    return {
      status: 'refused',
      errorType: 'rate_limit',
      message: error.message,
    };
  if (error instanceof AssistantTurnLimit)
    return { status: 'timeout', errorType: 'timeout', message: error.message };
  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  )
    return {
      status: 'timeout',
      errorType: 'timeout',
      message:
        'Не удалось закончить за отведённое время. Уже сохранённые задачи видны в /tasks. Попробуйте сузить запрос.',
    };
  return {
    status: 'error',
    errorType: error instanceof LlmRequestError ? 'llm_error' : 'internal',
    message:
      'Сейчас не удалось выполнить поручение. Попробуйте позже. Если создавали напоминание или встречу, посмотрите /tasks перед повтором.',
  };
}
