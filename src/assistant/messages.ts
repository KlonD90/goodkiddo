import type { AssistantStore } from '../persistence/assistant-store.js';
import { splitTelegramMarkdown } from '../channels/telegram-markdown-chunks.js';
import {
  textTarget,
  type TextTarget,
} from '../persistence/assistant-text-outbox.js';
import {
  snapshotBatch,
  snapshotPart,
} from '../persistence/assistant-delivery-ledger.js';

export function enqueueReply(
  store: AssistantStore,
  key: string,
  chatId: string,
  text: string,
  target: TextTarget = {},
): string[] {
  const chunks = splitTelegramMarkdown(text);
  const ids = chunks.map((_, i) => `${key}:${i}`);
  store.transaction(() => {
    const batch = snapshotBatch(store, chatId, key, target, text);
    chunks.forEach((chunk, i) => {
      const partTarget = {
        ...target,
        messageId: i === 0 ? target.messageId : undefined,
      };
      snapshotPart(
        store,
        batch,
        { id: ids[i], text: chunk },
        'text',
        partTarget,
      );
      store.send(ids[i], chatId, chunk);
      textTarget(store, ids[i], chatId, partTarget);
    });
  });
  return ids;
}
export function formatTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('ru', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(iso));
}
export function futureTime(value: string): string {
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value))
    throw new Error('Укажите время с часовым поясом.');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time <= Date.now())
    throw new Error('Нужно время в будущем.');
  if (time - Date.now() > 366 * 86400_000)
    throw new Error('Пока можно планировать только на год вперёд.');
  return new Date(time).toISOString();
}
