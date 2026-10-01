import type {
  Actor,
  AssistantJob,
  MeetingData,
  MeetingVote,
} from '../shared/assistant-types.js';
import type { AssistantStore } from '../persistence/assistant-store.js';
import { formatTime } from './messages.js';

export function meetingKeyboard(job: AssistantJob) {
  const data = JSON.parse(job.data) as MeetingData;
  return {
    inline_keyboard: [
      ...data.options.map((option, i) => [
        { text: option, callback_data: `meet:${job.id}:${i}` },
      ]),
      [{ text: 'Ничего не подходит', callback_data: `meet:${job.id}:none` }],
    ],
  };
}
export function meetingInvitation(job: AssistantJob, timezone: string): string {
  const data = JSON.parse(job.data) as MeetingData;
  return (
    `${job.title}\n\nВыберите все подходящие варианты кнопками ниже. Повторное нажатие снимает выбор.\n` +
    `Ответы принимаются до ${formatTime(job.due_at, timezone)} (${timezone}).\n` +
    (data.participants.length
      ? `Ждём: ${data.participants.join(', ')}.\n`
      : 'Участвовать может каждый в этом чате.\n') +
    `Встреча: ${job.id}`
  );
}
export function recordMeetingVote(
  store: AssistantStore,
  job: AssistantJob,
  actor: Actor,
  choice: string,
): string {
  if (job.status !== 'active' || job.due_at <= new Date().toISOString())
    return 'Сбор ответов уже завершён.';
  const data = JSON.parse(job.data) as MeetingData;
  const previous = store.votes(job.id).find((v) => v.user_id === actor.id);
  let choices: number[] = previous ? JSON.parse(previous.choices) : [];
  if (choice === 'none') choices = [];
  else {
    const index = Number(choice);
    if (!Number.isInteger(index) || index < 0 || index >= data.options.length)
      return 'Неизвестный вариант.';
    choices = choices.includes(index)
      ? choices.filter((i) => i !== index)
      : [...choices, index];
  }
  store.vote(job.id, actor, choices);
  return choices.length
    ? `Ваш выбор: ${choices.map((i) => data.options[i]).join('; ')}`
    : 'Записал: ни один вариант не подходит.';
}
export function missingParticipants(
  job: AssistantJob,
  votes: MeetingVote[],
): string[] {
  const { participants } = JSON.parse(job.data) as MeetingData;
  const responded = new Set(
    votes.filter((v) => v.username).map((v) => `@${v.username!.toLowerCase()}`),
  );
  return participants.filter((p) => !responded.has(p.toLowerCase()));
}
export function meetingResult(job: AssistantJob, votes: MeetingVote[]): string {
  const data = JSON.parse(job.data) as MeetingData;
  if (!votes.length)
    return `«${job.title}»: срок вышел, ответов пока нет. Время встречи не выбрано.`;
  const rows = data.options.map((option, i) => ({
    option,
    voters: votes.filter((v) =>
      (JSON.parse(v.choices) as number[]).includes(i),
    ),
  }));
  const highest = Math.max(...rows.map((r) => r.voters.length));
  const leaders = rows.filter((r) => r.voters.length === highest);
  const winner =
    highest === 0
      ? 'Ни один вариант не подошёл.'
      : leaders.length === 1
        ? `Больше всего голосов: ${leaders[0].option} — подходит ${highest} из ${votes.length} ответивших.`
        : `Поровну голосов: ${leaders.map((r) => r.option).join('; ')}. Нужно выбрать один из них.`;
  const missing = missingParticipants(job, votes);
  return (
    `Итог «${job.title}»\n\n${winner}\n\n` +
    rows.map((r) => `${r.option}: ${r.voters.length}`).join('\n') +
    (missing.length ? `\n\nНе ответили: ${missing.join(', ')}.` : '') +
    '\n\nБронирование не выполнялось.'
  );
}
