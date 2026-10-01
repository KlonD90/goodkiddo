import type { AssistantStore } from '../persistence/assistant-store.js';
import type { AssistantChat } from '../shared/assistant-types.js';
import { formatTime } from './messages.js';

export function taskOverview(
  store: AssistantStore,
  chat: AssistantChat,
): string {
  const jobs = store.jobs(chat.id);
  const todos = store.todos.list(chat.id);
  const recurring = store.promptJobs.list(chat.id);
  const sections: string[] = [];
  if (jobs.length)
    sections.push(
      jobs
        .map(
          (job) =>
            `${job.id} · ${job.kind === 'meeting' ? 'Встреча' : 'Напоминание'} · ${job.status}\n${job.title.slice(0, 180)}\n${formatTime(job.due_at, chat.timezone)} (${chat.timezone})${job.status === 'delivery_failed' ? '\nОшибка доставки. Повторить: /retry ' + job.id : ''}`,
        )
        .join('\n\n'),
    );
  if (todos.length)
    sections.push(
      `Дела: ${todos.length}\n${todos
        .slice(0, 20)
        .map((todo) => `${todo.id} · ${todo.title.slice(0, 180)}`)
        .join(
          '\n',
        )}${todos.length > 20 ? '\nПопросите показать остальные дела.' : ''}`,
    );
  if (recurring.length)
    sections.push(
      `Периодические поручения:\n${recurring.map((job) => `${job.id} · ${job.title} · ${job.status}`).join('\n')}\n/jobs — расписания и результаты; /pause ID, /resume ID, /cancel ID.`,
    );
  return sections.join('\n\n') || 'Активных задач пока нет.';
}
