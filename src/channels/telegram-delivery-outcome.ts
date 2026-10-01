import { TelegramApiError } from './telegram-assistant-api.js';

export class UncertainDelivery extends Error {
  constructor(kind = 'message') {
    super(
      `Telegram ${kind} send has an uncertain outcome; automatic resend suppressed.`,
    );
  }
}
export function ambiguousTelegramSend(error: unknown): boolean {
  return (
    !(error instanceof TelegramApiError) ||
    error.code === 0 ||
    error.code >= 500
  );
}
