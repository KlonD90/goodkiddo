import type { AssistantStore } from '../persistence/assistant-store.js';
import { deliveryStatusText } from './delivery-status.js';
import { retryDelivery } from '../persistence/assistant-delivery-retry.js';

export function deliveryCommand(
  store: AssistantStore,
  command: string,
  words: string[],
  chatId: string,
  authorId: string,
): string | undefined {
  if (!['/deliveries', '/delivery', '/retry_delivery'].includes(command))
    return undefined;
  try {
    if (command === '/deliveries') return deliveryStatusText(store, chatId);
    if (command === '/delivery') {
      if (!words[0])
        return 'Укажите ID: /delivery delivery-… . Список: /deliveries';
      return deliveryStatusText(store, chatId, words[0]);
    }
    retryDelivery(
      store,
      chatId,
      authorId,
      words[0] || '',
      words[1] === 'confirm',
    );
    return (
      'Неподтверждённые части поставлены в очередь. Уже подтверждённые части не повторяются. Статус: /delivery ' +
      words[0]
    );
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'Сейчас не удалось проверить доставку.';
  }
}
