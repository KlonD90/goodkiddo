export interface AssistantFileLimits {
  maxFileBytes: number;
  maxChatBytes: number;
  maxChatFiles: number;
  maxTotalBytes: number;
}

export const DEFAULT_FILE_LIMITS: AssistantFileLimits = {
  maxFileBytes: 20 * 1024 * 1024,
  maxChatBytes: 100 * 1024 * 1024,
  maxChatFiles: 1000,
  maxTotalBytes: 1024 * 1024 * 1024,
};
export const MAX_FILE_OUTPUT_CHARS = 12000;

export class AssistantFileError extends Error {}

export function virtualPath(input: string, directory = false): string {
  if (
    !input ||
    input.length > 512 ||
    /[\x00-\x1f\x7f\\~]/.test(input) ||
    /^[A-Za-z]:/.test(input) ||
    input.startsWith('//') ||
    input.split('/').includes('..')
  )
    throw new AssistantFileError(
      'Нужен путь внутри виртуальных файлов этого чата без .. и служебных символов.',
    );
  const parts = input.split('/').filter((part) => part && part !== '.');
  const result = '/' + parts.join('/');
  if (!directory && result === '/')
    throw new AssistantFileError('Укажите путь файла, а не корень.');
  return directory && result !== '/' ? result + '/' : result;
}

export function documentName(input?: string): string {
  return (
    (input?.split(/[\\/]/).at(-1) || 'document')
      .replace(/[\x00-\x1f\x7f~]/g, '_')
      .replace(/^\.+$/, 'document')
      .slice(0, 180) || 'document'
  );
}

export function safeMimeType(input?: string): string {
  return input && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(input)
    ? input
    : 'application/octet-stream';
}

export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fileText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AssistantFileError(
      'Это двоичный файл. Его можно отправить документом; текстовые инструменты требуют UTF-8.',
    );
  }
}
