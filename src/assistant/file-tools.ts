import { z } from 'zod';
import type { LlmTool } from '../providers/assistant-llm.js';
import { AssistantFiles } from '../persistence/assistant-files.js';
import { textBytes } from '../persistence/assistant-file-policy.js';
import { queueDocument } from '../persistence/assistant-document-outbox.js';
import { createFileGrant } from '../persistence/assistant-file-grants.js';
import { AssistantFileError } from '../persistence/assistant-file-policy.js';
import { fileGrantUrl } from '../server/assistant-file-links.js';
import { requestedFileLink } from './file-link-intent.js';
import type { ToolContext } from './tools.js';

const schemas = {
  ls: z.object({ path: z.string().default('/') }),
  read_file: z.object({
    file_path: z.string(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(100),
  }),
  write_file: z.object({ file_path: z.string(), content: z.string() }),
  edit_file: z.object({
    file_path: z.string(),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().default(false),
  }),
  glob: z.object({
    pattern: z.string().max(200),
    path: z.string().default('/'),
  }),
  grep: z.object({
    pattern: z.string().min(1).max(400),
    path: z.string().default('/'),
    case_sensitive: z.boolean().default(true),
  }),
  send_file: z.object({
    file_path: z.string(),
    caption: z.string().max(1024).default(''),
  }),
  grant_fs_access: z
    .object({
      file_paths: z.array(z.string()).min(1).max(20).optional(),
      scope_path: z
        .string()
        .optional()
        .describe(
          'Compatibility: a single file path, never root or a directory.',
        ),
      ttl_hours: z
        .number()
        .min(1 / 60)
        .max(24)
        .default(24),
    })
    .refine(
      (value) => !!value.file_paths !== !!value.scope_path,
      'Укажите file_paths или scope_path одного файла.',
    ),
};
const descriptions: Record<keyof typeof schemas, string> = {
  ls: 'List virtual files in this chat. Paths are virtual, never host files. Results capped at 100.',
  read_file:
    'Read a UTF-8 virtual file in this chat with line offset/limit. Binary files can be sent, not parsed by this tool.',
  write_file:
    'Create a UTF-8 file in this chat. Existing differing files require edit_file; no host filesystem access.',
  edit_file:
    'Replace a literal string in a UTF-8 file in this chat. Multiple matches need replace_all. No host access.',
  glob: 'Match virtual file paths in this chat with a glob pattern. No host paths or other chats.',
  grep: 'Search literal text in UTF-8 files in this chat. Binary files are skipped; results are bounded.',
  send_file:
    'Queue an immutable file snapshot as a Telegram document to this same chat. Use when the user requested the file. queued means persisted for delivery, not sent yet. Never supply a destination/chat ID.',
  grant_fs_access:
    'Create an expiring browser download link only after the current author explicitly asks for a file link. Select 1–20 file_paths from this chat; no root/directory listing, other chats or host files. Snapshots expire within 24h and are accessible to whoever holds the link. Never publish automatically after write_file or send_file.',
};
export function fileToolDefinitions(sharesEnabled = false): LlmTool[] {
  return (Object.keys(schemas) as (keyof typeof schemas)[])
    .filter((name) => name !== 'grant_fs_access' || sharesEnabled)
    .map((name) => ({
      type: 'function',
      function: {
        name,
        description: descriptions[name],
        parameters: z.toJSONSchema(schemas[name]),
      },
    }));
}
export function isFileTool(name: string): boolean {
  return Object.hasOwn(schemas, name);
}
export function executeFileTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): unknown {
  const files = new AssistantFiles(ctx.store.db, ctx.config.fileLimits);
  const chatId = ctx.request.chat.id;
  switch (name) {
    case 'ls': {
      const { path } = schemas.ls.parse(input);
      const all = files.list(chatId, path);
      return { files: all.slice(0, 100), truncated: all.length > 100 };
    }
    case 'read_file': {
      const a = schemas.read_file.parse(input);
      return files.read(chatId, a.file_path, a.offset, a.limit);
    }
    case 'write_file': {
      const a = schemas.write_file.parse(input);
      return files.write(chatId, a.file_path, textBytes(a.content));
    }
    case 'edit_file': {
      const a = schemas.edit_file.parse(input);
      return files.edit(
        chatId,
        a.file_path,
        a.old_string,
        a.new_string,
        a.replace_all,
      );
    }
    case 'glob': {
      const a = schemas.glob.parse(input);
      return files.glob(chatId, a.pattern, a.path);
    }
    case 'grep': {
      const a = schemas.grep.parse(input);
      return files.grep(chatId, a.pattern, a.path, a.case_sensitive);
    }
    case 'send_file': {
      const a = schemas.send_file.parse(input);
      return queueDocument(
        ctx.store,
        files,
        chatId,
        a.file_path,
        a.caption,
        ctx.taskId,
        {
          ownerId: ctx.request.actor.id,
          threadId: ctx.request.messageThreadId,
        },
      );
    }
    case 'grant_fs_access': {
      if (!ctx.config.fileShares.enabled)
        throw new AssistantFileError(
          'Браузерные ссылки пока не включены. Можно отправить файл документом.',
        );
      const a = schemas.grant_fs_access.parse(input),
        paths = a.file_paths || [a.scope_path!];
      if (!requestedFileLink(ctx.request, paths))
        throw new AssistantFileError(
          'Для публикации файла нужна явная просьба автора текущего сообщения о браузерной ссылке.',
        );
      const grant = createFileGrant(
        ctx.store.db,
        files,
        chatId,
        paths,
        a.ttl_hours,
      );
      return {
        url: fileGrantUrl(ctx.config.fileShares.publicBaseUrl, grant.token),
        expires_at: new Date(grant.expiresAt).toISOString(),
        files: grant.files,
        access:
          'Anyone holding this link can download only these file snapshots until expiry.',
      };
    }
    default:
      throw new Error('Неизвестный файловый инструмент.');
  }
}
