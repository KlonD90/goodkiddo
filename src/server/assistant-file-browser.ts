import { posix } from 'node:path';
import type { AssistantStore } from '../persistence/assistant-store.js';
import {
  fileGrantEntries,
  grantedFileBytes,
  previewPageToken,
  type FileGrant,
  type GrantedFile,
} from '../persistence/assistant-file-grants.js';
import { fileGrantPreviewOrdinals } from '../persistence/assistant-file-previews.js';
import { fileText, virtualPath } from '../persistence/assistant-file-policy.js';
import {
  resourceKind,
  resourceUrl,
  staticAsset,
} from '../capabilities/pages/resources.js';

export function escaped(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );
}
export function fileDownloadPath(token: string, file: GrantedFile): string {
  return `/fs/${token}/${file.ordinal}/${encodeURIComponent(file.filename).replace(/[!'()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase())}`;
}
function browsePath(token: string, directory: string, view?: number): string {
  const parameters = new URLSearchParams({ uuid: token, dir: directory });
  if (view !== undefined) parameters.set('view', String(view));
  return '/fs/?' + parameters.toString();
}

/** Trusted UI contains only selected snapshot names and escaped text, never active user HTML. */
export function renderFileBrowser(
  store: AssistantStore,
  grant: FileGrant,
  token: string,
  url: URL,
  now: number,
): string | undefined {
  const entries = fileGrantEntries(store.db, grant);
  const directory = virtualPath(url.searchParams.get('dir') || '/', true);
  const selected = entries.filter((file) => file.path.startsWith(directory));
  if (!selected.length) return undefined;
  const previews = fileGrantPreviewOrdinals(store.db, grant.token_hash, now);
  const pageLink = (file: (typeof entries)[number]) =>
    previews.has(file.ordinal)
      ? `<a href="${escaped(resourceUrl(previewPageToken(token, file.ordinal), file.path))}" target="_blank" rel="noopener noreferrer">Открыть HTML</a>`
      : '';
  const folders = [
    ...new Set(
      selected
        .map((file) => file.path.slice(directory.length).split('/'))
        .filter((parts) => parts.length > 1)
        .map((parts) => parts[0]),
    ),
  ];
  const rows = folders.map(
    (folder) =>
      `<tr><td>📁 <a href="${escaped(browsePath(token, directory + folder + '/'))}">${escaped(folder)}/</a></td><td>Папка</td><td></td></tr>`,
  );
  rows.push(
    ...selected
      .filter((file) => !file.path.slice(directory.length).includes('/'))
      .map(
        (file) =>
          `<tr><td><a href="${escaped(browsePath(token, directory, file.ordinal))}">${escaped(file.filename)}</a></td><td>${file.size} байт</td><td>${pageLink(file)} <a href="${escaped(fileDownloadPath(token, file))}">Скачать</a></td></tr>`,
      ),
  );
  let preview = '';
  const view = url.searchParams.get('view');
  if (view !== null) {
    if (!/^(0|[1-9][0-9]?)$/.test(view)) return undefined;
    const file = selected.find((entry) => String(entry.ordinal) === view);
    if (!file) return undefined;
    const content = grantedFileBytes(store.db, grant, file.ordinal)!;
    let rendered: string;
    try {
      if (resourceKind(file.path) === 'image') {
        staticAsset(file.path, content);
        rendered = `<img src="/fs/${token}/image/${file.ordinal}" alt="${escaped(file.filename)}">`;
      } else {
        const text = fileText(content);
        rendered = `<pre>${escaped(text.slice(0, 12000))}</pre>${text.length > 12000 ? '<p>Показаны первые 12000 символов. Скачайте файл для полного содержания.</p>' : ''}`;
      }
    } catch {
      rendered =
        '<p>Предпросмотр этого формата или размера недоступен. Файл можно скачать.</p>';
    }
    preview = `<section><h2>${escaped(file.filename)}</h2><p>${pageLink(file)} <a href="${escaped(fileDownloadPath(token, file))}">Скачать</a></p>${rendered}</section>`;
  }
  const parentDirectory = posix.dirname(directory.slice(0, -1));
  const parent =
    directory === '/'
      ? ''
      : `<a href="${escaped(browsePath(token, parentDirectory === '/' ? '/' : parentDirectory + '/'))}">← На уровень выше</a>`;
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Файлы GoodKiddo</title><style>body{font:16px system-ui;margin:2rem auto;max-width:70rem;padding:0 1rem;color:#20302a;background:#f7f8f5}a{color:#165c45}table{width:100%;border-collapse:collapse}td{padding:.8rem;border-bottom:1px solid #dce3dc}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:1rem}img{max-width:100%;height:auto}section{margin-top:2rem}</style><h1>Файлы GoodKiddo</h1><p>Это неизменяемая копия только выбранных файлов. Ссылка доступна любому, кто её получил, до ${escaped(new Date(grant.expires_at).toISOString())}.</p><nav><a href="${escaped(browsePath(token, '/'))}">Выбранные файлы</a> ${parent}</nav><h2>${escaped(directory)}</h2><table>${rows.join('')}</table>${preview}</html>`;
}
