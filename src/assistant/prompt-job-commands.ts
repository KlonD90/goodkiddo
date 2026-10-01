import type { AssistantStore } from '../persistence/assistant-store.js';
import { formatTime } from './messages.js';

export function promptJobCommand(
  store: AssistantStore,
  chatId: string,
  ownerId: string,
  command: string,
  id: string,
): string | undefined {
  if (command === '/jobs') {
    const jobs = store.promptJobs.list(chatId);
    return jobs.length
      ? jobs
          .map((job) => {
            const last = store.promptJobs.runs(chatId, job.id)[0];
            return `${job.id} · ${job.title}\n${job.status} · ${job.cron} (${job.timezone})\nСледующий: ${formatTime(job.nextRun, job.timezone)}\nУведомления: ${job.notification}; лимиты: ${job.maxCalls} шагов, ${job.maxSearches} поиска, ${job.maxCostUsd} USD/запуск${last ? '\nПоследний результат: ' + last.id + ' · ' + last.status : ''}`;
          })
          .join('\n\n')
      : 'Периодических заданий пока нет. Попросите сохранить поручение с расписанием и часовым поясом.';
  }
  if (
    command !== '/pause' &&
    command !== '/resume' &&
    !(command === '/cancel' && store.promptJobs.get(id)?.chatId === chatId)
  )
    return;
  try {
    const status =
      command === '/pause'
        ? 'paused'
        : command === '/resume'
          ? 'active'
          : 'cancelled';
    const job = store.promptJobs.update(chatId, ownerId, id, { status });
    return `Задание ${job.id}: ${job.status}.${status === 'active' ? '\nСледующий запуск: ' + formatTime(job.nextRun, job.timezone) : ''}`;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'Не удалось изменить задание.';
  }
}
