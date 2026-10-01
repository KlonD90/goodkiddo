import { z } from 'zod';
import type { LlmTool } from '../providers/assistant-llm.js';
import { extractAttachment } from '../capabilities/documents/extract.js';

export interface AttachmentStore {
  get(
    chatId: string,
    path: string,
  ): { path: string; content: Uint8Array; mime_type: string };
}
const schema = z.object({ file_path: z.string().max(300) });
export function attachmentToolDefinitions(): LlmTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'extract_file',
        description:
          'Extract bounded text from a PDF, CSV, XLSX or UTF-8 file already stored in this chat. Use its virtual path from ls. Does not run formulas or OCR scanned PDFs; at most 50 PDF pages, 200 sheet rows, 20 columns, 20,000 characters.',
        parameters: z.toJSONSchema(schema),
      },
    },
  ];
}
export async function executeAttachmentTool(
  input: unknown,
  context: { signal: AbortSignal; request: { chat: { id: string } } },
  files: AttachmentStore,
) {
  const { file_path } = schema.parse(input);
  const file = files.get(context.request.chat.id, file_path);
  return {
    path: file.path,
    ...(await extractAttachment({
      filename: file.path,
      mimeType: file.mime_type,
      bytes: file.content,
      signal: context.signal,
    })),
  };
}
