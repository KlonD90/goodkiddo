import type { AssistantConfig } from '../config/assistant-config.js';
import type { AssistantAnalytics } from '../integrations/assistant-analytics.js';
import type { AssistantStore } from '../persistence/assistant-store.js';
import type {
  PromptJob,
  PromptRun,
} from '../persistence/assistant-prompt-jobs.js';
import type { InboundRequest, TaskStatus } from '../shared/assistant-types.js';
import { ContextCleared } from '../assistant/context.js';
import { enqueueReply } from '../assistant/messages.js';

export function claimPromptRequest(
  store: AssistantStore,
  config: AssistantConfig,
  now = new Date(),
): InboundRequest | undefined {
  const claimed = store.promptJobs.claim(now);
  return claimed
    ? promptRequest(store, config, claimed.job, claimed.runId)
    : undefined;
}
function promptRequest(
  store: AssistantStore,
  config: AssistantConfig,
  job: PromptJob,
  runId: string,
): InboundRequest {
  return {
    updateId: 0,
    chat: store.chat(job.chatId)!,
    actor: { id: job.ownerId, name: 'Автор периодического поручения' },
    interaction: 'message',
    text: `Периодическое поручение «${job.title}»:\n${job.prompt}\nВерни текст результата. Не создавай новые задания и не меняй память, дела, настройки или файлы. Уведомлениями управляет scheduler.`,
    messageAt: new Date().toISOString(),
    contextVersion: store.contextVersion(job.chatId),
    scheduled: {
      jobId: job.id,
      runId,
      revision: job.revision,
      notification: job.notification,
      maxCalls: Math.min(config.maxCalls, job.maxCalls, 6),
      maxSearches: Math.min(config.maxSearches, job.maxSearches, 3),
      maxCostUsd: Math.min(config.monthlyBudget, job.maxCostUsd, 1),
    },
  };
}
export function assertScheduledTurn(
  store: AssistantStore,
  request: InboundRequest,
): void {
  if (
    request.scheduled &&
    !store.promptJobs.isCurrent(
      request.scheduled.jobId,
      request.scheduled.revision,
    )
  )
    throw new ContextCleared(
      'Периодическое поручение изменено или приостановлено.',
    );
}
export function finishPromptTurn(
  store: AssistantStore,
  request: InboundRequest,
  text: string,
  status: TaskStatus,
): boolean {
  const scheduled = request.scheduled!;
  return store.transaction(() => {
    const run = store.promptJobs.result(request.chat.id, scheduled.runId);
    if (run.status !== 'running' && run.status !== 'claimed') return false;
    if (
      !store.promptJobs.isCurrent(scheduled.jobId, scheduled.revision) ||
      request.contextVersion !== store.contextVersion(request.chat.id)
    ) {
      store.promptJobs.finish(scheduled.runId, 'cancelled', text, false);
      return false;
    }
    const job = store.promptJobs.get(scheduled.jobId)!;
    const success = status === 'success';
    const notify =
      status !== 'cancelled' &&
      scheduled.notification !== 'silent' &&
      (!success || scheduled.notification !== 'errors_only');
    store.promptJobs.finish(scheduled.runId, status, text, notify);
    if (!notify) return false;
    const paused = store.promptJobs.get(job.id)!.status === 'paused';
    const body =
      success && scheduled.notification === 'summary'
        ? text.slice(0, 480)
        : text;
    const message = `Периодическое поручение «${job.title}»:\n${body}\nРезультат: ${scheduled.runId}${paused ? '\nЗадание приостановлено после трёх ошибок. Проверьте /jobs перед возобновлением.' : ''}`;
    for (const id of enqueueReply(
      store,
      `prompt-result:${scheduled.runId}`,
      request.chat.id,
      message,
      {
        runId: scheduled.runId,
        ownerId: request.actor.id,
        threadId: request.messageThreadId,
      },
    ))
      store.setState(`delivery_run:${id}`, scheduled.runId);
    return true;
  });
}
export function recoverPromptTurns(
  store: AssistantStore,
  config: AssistantConfig,
  analytics: AssistantAnalytics,
): void {
  const interrupted = store.db
    .query(
      "SELECT * FROM assistant_prompt_runs WHERE status IN ('claimed','running')",
    )
    .all() as PromptRun[];
  for (const run of interrupted) {
    const job = store.promptJobs.get(run.job_id);
    if (!job || !store.chat(job.chatId)?.active) {
      store.promptJobs.finish(run.id, 'cancelled', 'Чат недоступен.', false);
      continue;
    }
    const prior = store.db
      .query('SELECT status FROM assistant_runs WHERE id=?')
      .get(run.id) as { status: string } | null;
    if (prior?.status === 'cancelled') {
      store.promptJobs.finish(
        run.id,
        'cancelled',
        'Контекст очищен или задача отменена.',
        false,
      );
      continue;
    }
    const request = promptRequest(
      store,
      config,
      { ...job, revision: run.revision },
      run.id,
    );
    analytics.start(run.id, request.chat, job.ownerId, 'other', 'bot');
    finishPromptTurn(
      store,
      request,
      'Запуск прервался при перезапуске. Повторно эта попытка не выполняется; следующий запуск — по сохранённому расписанию.',
      'error',
    );
    analytics.finish(run.id, request.chat, job.ownerId, 'error', 'internal');
  }
}
