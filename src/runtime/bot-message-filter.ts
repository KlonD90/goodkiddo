import { isSessionCommandControlMessage } from './session-commands.js';
import { NewMessage } from '../shared/types.js';

/**
 * Filter messages before processing.
 * - Normal rooms: drop all bot messages.
 * - Paired rooms (allowBotMessages=true): keep other bot's messages,
 *   but drop messages authored by this service's own bot (via isOwnMessage).
 */
export function filterProcessableMessages(
  messages: NewMessage[],
  allowBotMessages: boolean,
  isOwnMessage?: (msg: NewMessage) => boolean,
): NewMessage[] {
  const withoutControlMessages = messages.filter(
    (message) =>
      !(
        message.is_bot_message &&
        isSessionCommandControlMessage(message.content)
      ),
  );

  if (allowBotMessages) {
    if (isOwnMessage) {
      return withoutControlMessages.filter((m) => !isOwnMessage(m));
    }
    return withoutControlMessages;
  }

  return withoutControlMessages.filter((message) => !message.is_bot_message);
}
