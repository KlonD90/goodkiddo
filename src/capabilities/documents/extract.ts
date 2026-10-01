import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { validateSpreadsheetArchive } from './archive-policy.js';
import { DOCUMENT_WORKER_SOURCE } from './worker-source.js';

export interface AttachmentInput {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  signal: AbortSignal;
}
export interface ExtractedAttachment {
  format: 'pdf' | 'csv' | 'xlsx' | 'text';
  text: string;
  truncated: boolean;
  pages?: number;
  untrusted: true;
}
export function attachmentFormat(
  filename: string,
  mimeType: string,
): ExtractedAttachment['format'] | null {
  if (/\.pdf$/i.test(filename) || mimeType === 'application/pdf') return 'pdf';
  if (
    /\.csv$/i.test(filename) ||
    ['text/csv', 'application/csv'].includes(mimeType)
  )
    return 'csv';
  if (
    /\.xlsx$/i.test(filename) ||
    mimeType ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
    return 'xlsx';
  if (/^text\//.test(mimeType) || /\.(txt|md|json|log)$/i.test(filename))
    return 'text';
  return null;
}

export async function extractAttachment(
  input: AttachmentInput,
): Promise<ExtractedAttachment> {
  input.signal.throwIfAborted();
  if (input.bytes.length > 10 * 1024 * 1024)
    throw new Error('Файл превышает лимит обработки 10 MiB.');
  const format = attachmentFormat(input.filename, input.mimeType);
  if (!format)
    throw new Error(
      'Формат не поддерживается. Для старого XLS сохраните файл как XLSX или CSV.',
    );
  if (format === 'text') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
    return {
      format,
      text: text.slice(0, 20_000),
      truncated: text.length > 20_000,
      untrusted: true,
    };
  }
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
  if (format === 'xlsx') await validateSpreadsheetArchive(input.bytes, signal);
  const require = createRequire(import.meta.url);
  return new Promise((resolve, reject) => {
    const worker = new Worker(DOCUMENT_WORKER_SOURCE, {
      eval: true,
      workerData: {
        format,
        bytes: input.bytes,
        modules: {
          pdf: require.resolve('pdf-parse'),
          csv: require.resolve('csv-parse/sync'),
          excel: require.resolve('exceljs'),
        },
      },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let settled = false;
    const finish = (result?: {
      ok: boolean;
      text?: string;
      truncated?: boolean;
      pages?: number;
    }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (!result?.ok || typeof result.text !== 'string')
        reject(
          new Error(
            'Не удалось прочитать файл: он повреждён, защищён паролем или обработка остановлена.',
          ),
        );
      else
        resolve({
          format,
          text: result.text.slice(0, 20_000),
          truncated: !!result.truncated,
          pages: result.pages,
          untrusted: true,
        });
    };
    const abort = () => finish();
    signal.addEventListener('abort', abort, { once: true });
    worker.on('message', finish);
    worker.on('error', () => finish());
    worker.on('exit', () => finish());
    if (signal.aborted) abort();
  });
}
