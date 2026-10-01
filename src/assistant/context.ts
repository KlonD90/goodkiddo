import type { AssistantStore } from '../persistence/assistant-store.js';
import type { InboundRequest } from '../shared/assistant-types.js';
import { discardRunDeliveries } from '../persistence/assistant-delivery-links.js';
import { cancelDeliverySnapshots } from '../persistence/assistant-delivery-ledger.js';

export class ContextCleared extends Error {}
const turns = new WeakMap<AssistantStore, Map<string, Set<AbortController>>>();

export function assertCurrentContext(
  store: AssistantStore,
  request: InboundRequest,
): void {
  if (
    request.contextVersion !== undefined &&
    request.contextVersion !== store.contextVersion(request.chat.id)
  )
    throw new ContextCleared('Контекст этой задачи очищен.');
}
export function registerContextTurn(
  store: AssistantStore,
  chatId: string,
): { signal: AbortSignal; release: () => void } {
  const chats = turns.get(store) || new Map<string, Set<AbortController>>();
  turns.set(store, chats);
  const controllers = chats.get(chatId) || new Set<AbortController>();
  chats.set(chatId, controllers);
  const controller = new AbortController();
  controllers.add(controller);
  return {
    signal: controller.signal,
    release: () => {
      controllers.delete(controller);
      if (!controllers.size) chats.delete(chatId);
    },
  };
}
export function clearChatContext(store: AssistantStore, chatId: string): void {
  for (const controller of turns.get(store)?.get(chatId) || [])
    controller.abort(new ContextCleared());
  store.transaction(() => {
    store.forget(chatId);
    cancelDeliverySnapshots(store, chatId);
    const running = store.db
      .query(
        "SELECT id FROM assistant_runs WHERE chat_id=? AND user_id IS NOT NULL AND status='running'",
      )
      .all(chatId) as { id: string }[];
    for (const run of running) {
      discardRunDeliveries(store, run.id);
      store.db
        .query(
          "UPDATE assistant_runs SET status='cancelled',finished_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), run.id);
    }
  });
}
