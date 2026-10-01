import type { LlmMessage } from '../shared/assistant-types.js';

export interface ImageInput {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'auto' } };
export type WireMessage = Omit<LlmMessage, 'content'> & {
  content: LlmMessage['content'] | ContentPart[];
};

export function imagePart(image: ImageInput): ContentPart {
  if (image.bytes.length > 5 * 1024 * 1024)
    throw new Error('Изображение превышает лимит 5 MiB.');
  const bytes = image.bytes;
  const png =
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  const jpeg =
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255;
  const webp =
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString() === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP';
  const mime = png
    ? 'image/png'
    : jpeg
      ? 'image/jpeg'
      : webp
        ? 'image/webp'
        : null;
  if (!mime || mime !== image.mimeType)
    throw new Error('Поддерживаются корректные PNG, JPEG и WebP изображения.');
  return {
    type: 'image_url',
    image_url: {
      url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
      detail: 'auto',
    },
  };
}
export function withImages(
  messages: LlmMessage[],
  images: ImageInput[] = [],
): WireMessage[] {
  if (!images.length) return messages;
  if (images.length > 2)
    throw new Error(
      'За один запрос можно обработать не больше двух изображений.',
    );
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === 'user') {
      index = i;
      break;
    }
  if (index < 0) throw new Error('Для изображения нужен запрос пользователя.');
  return messages.map((message, i) =>
    i !== index
      ? message
      : {
          ...message,
          content: [
            { type: 'text', text: message.content || 'Опиши изображение.' },
            ...images.map(imagePart),
          ],
        },
  );
}
