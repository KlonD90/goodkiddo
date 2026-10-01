import type { AssistantStore } from '../persistence/assistant-store.js';
import type { AssistantAnalytics } from '../integrations/assistant-analytics.js';
import {
  meetingKeyboard,
  meetingResult,
  missingParticipants,
} from '../assistant/meetings.js';
import { queueJobDelivery } from './assistant-job-delivery.js';

export function advanceAssistantJobs(
  store: AssistantStore,
  analytics: AssistantAnalytics,
): void {
  for (const job of store.dueJobs(new Date().toISOString())) {
    const chat = store.chat(job.chat_id);
    if (!chat?.active) continue;
    store.transaction(() => {
      if (job.due_at <= new Date().toISOString()) {
        const text =
          job.kind === 'reminder'
            ? `Напоминание: ${job.title}`
            : meetingResult(job, store.votes(job.id));
        const runId = queueJobDelivery(store, job, text);
        analytics.start(runId, chat, null, job.kind, 'bot');
        store.remember(chat.id, 'assistant', text);
      } else if (job.kind === 'meeting' && !job.reminded) {
        const votes = store.votes(job.id);
        const missing = missingParticipants(job, votes);
        const participants = (
          JSON.parse(job.data) as { participants: string[] }
        ).participants;
        if (missing.length || !participants.length)
          store.send(
            `nudge:${job.id}`,
            chat.id,
            `Напоминание о «${job.title}». ${missing.length ? `${missing.join(', ')}, ещё ждём ваши ответы.` : 'Кто ещё не ответил — выберите удобное время.'}`,
            meetingKeyboard(job),
          );
        store.markReminded(job.id);
      }
    });
  }
}
