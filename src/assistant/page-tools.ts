import { z } from 'zod';
import type { LlmTool } from '../providers/assistant-llm.js';
import type { ToolContext } from './tools.js';
import { AssistantFiles } from '../persistence/assistant-files.js';
import { virtualPath } from '../persistence/assistant-file-policy.js';
import {
  listMiniPages,
  publishMiniPage,
  revokeMiniPage,
} from '../persistence/assistant-pages.js';
import { preparePageBundle } from '../capabilities/pages/bundle.js';
import { miniPageUrl } from '../server/assistant-mini-pages.js';
import { requestedMiniPage } from './page-intent.js';
import { assertCurrentContext } from './context.js';

const schemas = {
  publish_page: z.object({
    file_path: z.string(),
    title: z.string().min(1).max(160),
    asset_paths: z.array(z.string()).max(40).default([]),
    ttl_hours: z
      .number()
      .min(1 / 60)
      .max(24)
      .default(24),
  }),
  list_pages: z.object({}),
  revoke_page: z.object({ id: z.string().min(1).max(80) }),
};
const descriptions = {
  publish_page:
    'Publish a static mini-page from a UTF-8 .html virtual file and explicitly selected asset_paths from this chat. First write_file, then publish_page; return exact URL, expiry and ID. Relative references to selected HTML/CSS/PNG/JPEG/GIF/WebP/WOFF/WOFF2 assets work; inline CSS and data images also work. Immutable 24h snapshot; HTML 256 KiB, at most 40 assets/2 MiB each/5 MiB total. Only after the current author asks to create/publish a page. Scripts/forms/frames/SVG/external resources are disabled. Never include unrelated private files or execute code.',
  list_pages:
    'List active mini-page IDs, titles, source paths and expiry in this chat. Bearer URLs are delivered at publication, not reconstructed here.',
  revoke_page:
    'Revoke one of the current author’s mini-page publications in this chat by ID. The public URL then returns 404; source file stays intact.',
};
export function pageToolDefinitions(enabled = false): LlmTool[] {
  return (Object.keys(schemas) as (keyof typeof schemas)[])
    .filter((name) => name !== 'publish_page' || enabled)
    .map((name) => ({
      type: 'function',
      function: {
        name,
        description: descriptions[name],
        parameters: z.toJSONSchema(schemas[name]),
      },
    }));
}
export function isPageTool(name: string): boolean {
  return Object.hasOwn(schemas, name);
}
export function executePageTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): unknown {
  assertCurrentContext(ctx.store, ctx.request);
  ctx.signal.throwIfAborted();
  const chatId = ctx.request.chat.id;
  if (name === 'list_pages') {
    schemas.list_pages.parse(input);
    return listMiniPages(ctx.store.db, chatId);
  }
  if (ctx.request.forwarded || ctx.request.scheduled)
    throw new Error('Публикацией управляет только автор прямого сообщения.');
  if (name === 'revoke_page')
    return revokeMiniPage(
      ctx.store.db,
      chatId,
      ctx.request.actor.id,
      schemas.revoke_page.parse(input).id,
    );
  if (name !== 'publish_page')
    throw new Error('Неизвестный инструмент мини-страниц.');
  if (!ctx.config.miniPages?.enabled || !ctx.config.fileShares?.enabled)
    throw new Error(
      'Публикация мини-страниц пока не включена. Можно подготовить HTML-файл.',
    );
  const args = schemas.publish_page.parse(input);
  const sourcePath = virtualPath(args.file_path);
  if (!/\.html?$/i.test(sourcePath))
    throw new Error('Для мини-страницы выберите один .html файл этого чата.');
  if (!requestedMiniPage(ctx.request, sourcePath))
    throw new Error(
      'Для публикации мини-страницы нужна явная просьба автора текущего сообщения.',
    );
  const files = new AssistantFiles(ctx.store.db, ctx.config.fileLimits);
  const file = files.get(chatId, sourcePath);
  const prepared = preparePageBundle(
    file,
    args.asset_paths.map((path) => files.get(chatId, path)),
    args.title,
  );
  const page = publishMiniPage(ctx.store.db, ctx.config.fileLimits, {
    chatId,
    ownerId: ctx.request.actor.id,
    sourcePath,
    title: args.title.trim(),
    html: prepared.html,
    assets: prepared.assets,
    token: prepared.token,
    hours: args.ttl_hours,
  });
  return {
    id: page.id,
    url: miniPageUrl(page.token, sourcePath),
    expires_at: new Date(page.expiresAt).toISOString(),
    removed_attributes_or_elements: prepared.removed,
    access:
      'Anyone holding this link can view this static snapshot until expiry or owner revocation.',
    limitations:
      'Static HTML/CSS and selected assets only. Scripts, forms and external resources are disabled.',
  };
}
