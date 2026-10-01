import type { AssistantConfig } from '../config/assistant-config.js';
import type {
  TelegramAssistantApi,
  TelegramMessage,
} from '../channels/telegram-assistant-api.js';
import type { AssistantStore } from '../persistence/assistant-store.js';
import { AssistantFiles } from '../persistence/assistant-files.js';
import { AssistantFileError } from '../persistence/assistant-file-policy.js';
import { telegramDate } from './documents.js';
import { imagePart, type ImageInput } from '../providers/assistant-vision.js';

export function visionSupported(config: AssistantConfig): boolean {
  return (
    config.baseUrl === 'https://opencode.ai/inference/openai/v1' &&
    config.model === 'space-bunny-free'
  );
}
export async function ingestPhoto(
  store: AssistantStore,
  config: AssistantConfig,
  api: TelegramAssistantApi,
  message: TelegramMessage,
  updateId: number,
) {
  const files = new AssistantFiles(store.db, config.fileLimits);
  const origin = `telegram:${updateId}`;
  const previous = files.byOrigin(String(message.chat.id), origin);
  if (previous) return previous;
  const photo = message.photo
    ?.slice()
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!photo) throw new AssistantFileError('Telegram не предоставил фото.');
  const maxBytes = Math.min(5 * 1024 * 1024, config.fileLimits.maxFileBytes);
  if (photo.file_size !== undefined && photo.file_size > maxBytes)
    throw new AssistantFileError('Фото превышает лимит 5 MiB.');
  const bytes = await api.downloadDocument(photo.file_id, maxBytes);
  imagePart({ filename: 'photo.jpg', mimeType: 'image/jpeg', bytes });
  return files.write(
    String(message.chat.id),
    `/uploads/telegram-${updateId}/photo.jpg`,
    bytes,
    'image/jpeg',
    origin,
    telegramDate(message.forward_origin?.date ?? message.date),
  );
}
export function storedImages(
  store: AssistantStore,
  config: AssistantConfig,
  chatId: string,
  paths: string[] = [],
): ImageInput[] {
  if (!paths.length) return [];
  if (!visionSupported(config))
    throw new AssistantFileError(
      'Понимание изображений для текущей модели не подтверждено.',
    );
  if (paths.length > 2)
    throw new AssistantFileError(
      'За один запрос можно обработать не больше двух изображений.',
    );
  const files = new AssistantFiles(store.db, config.fileLimits);
  return paths.map((path) => {
    const file = files.get(chatId, path);
    return {
      filename: file.path,
      mimeType: file.mime_type,
      bytes: file.content,
    };
  });
}
