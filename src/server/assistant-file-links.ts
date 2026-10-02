import type { AssistantStore } from '../persistence/assistant-store.js';
import type { AssistantConfig } from '../config/assistant-config.js';
import { miniPageHandler } from './assistant-mini-pages.js';
import {
  fileGrant,
  grantedFileBytes,
  type GrantedFile,
} from '../persistence/assistant-file-grants.js';

export const FILE_LINK_BIND = { hostname: '127.0.0.1', port: 4184 } as const;
const headers = {
  'Cache-Control': 'private, no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-downloads",
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};
function escaped(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );
}
function unicode(value: string): string {
  return Buffer.from(value, 'utf8').toString('utf8');
}
function encoded(value: string): string {
  return encodeURIComponent(unicode(value)).replace(
    /[!'()*]/g,
    (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
  );
}
function downloadPath(token: string, file: GrantedFile): string {
  return `/fs/${token}/${file.ordinal}/${encoded(file.filename)}`;
}
export function fileGrantUrl(origin: string, token: string): string {
  return `${origin}/fs/?uuid=${token}`;
}
function absent(): Response {
  return new Response('Файл или ссылка недоступны.', {
    status: 404,
    headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** Pure handler is testable without exposing a port; never logs capability URLs. */
export function fileLinkHandler(
  store: AssistantStore,
  clock: () => number = Date.now,
) {
  let downloading = 0;
  return (request: Request): Response => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return new Response('Method not allowed', {
          status: 405,
          headers: { ...headers, Allow: 'GET, HEAD' },
        });
      const url = new URL(request.url);
      const index = url.pathname === '/fs/' || url.pathname === '/fs';
      const match = url.pathname.match(
        /^\/fs\/([A-Za-z0-9_-]{43})\/([0-9]{1,2})\/([^/]{1,600})$/,
      );
      const token = index ? url.searchParams.get('uuid') : match?.[1];
      if (!token) return absent();
      const grant = fileGrant(store.db, token, clock());
      if (!grant) return absent();
      if (index) {
        const list = grant.files
          .map(
            (file) =>
              `<li><a href="${downloadPath(token, file)}" rel="noreferrer">${escaped(file.filename)}</a> · ${file.size} байт</li>`,
          )
          .join('');
        const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Файлы GoodKiddo</title><h1>Файлы GoodKiddo</h1><p>Ссылка доступна любому, кто её получил, до ${escaped(new Date(grant.expires_at).toISOString())}.</p><ul>${list}</ul></html>`;
        return new Response(request.method === 'HEAD' ? null : html, {
          headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (!match) return absent();
      const file = grant.files.find(
        (file) => String(file.ordinal) === match[2],
      );
      if (!file || decodeURIComponent(match[3]) !== file.filename)
        return absent();
      const disposition = `attachment; filename="${file.filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encoded(file.filename)}`;
      const downloadHeaders = {
        ...headers,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': disposition,
        'Content-Length': String(file.size),
      };
      if (request.method === 'HEAD')
        return new Response(null, { headers: downloadHeaders });
      if (downloading >= 4)
        return new Response('Попробуйте через несколько секунд.', {
          status: 503,
          headers: { ...headers, 'Retry-After': '2' },
        });
      const content = grantedFileBytes(store.db, grant, file.ordinal);
      if (!content) return absent();
      downloading++;
      let offset = 0,
        released = false;
      const release = () => {
        if (!released) {
          released = true;
          downloading--;
        }
      };
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= content.length) {
            controller.close();
            release();
            return;
          }
          const end = Math.min(content.length, offset + 65536);
          controller.enqueue(content.subarray(offset, end));
          offset = end;
        },
        cancel() {
          release();
        },
      });
      return new Response(body, { headers: downloadHeaders });
    } catch {
      return absent();
    }
  };
}

export function startFileLinkServer(
  config: AssistantConfig,
  store: AssistantStore,
) {
  if (!config.fileShares.enabled) return undefined;
  // A busy port makes startup fail. Never evict another service or choose a fallback port.
  return Bun.serve({
    ...FILE_LINK_BIND,
    maxRequestBodySize: 1024,
    fetch: publicArtifactHandler(config, store),
    error: () => new Response('Service unavailable', { status: 503, headers }),
  });
}

/** Mini-pages have a separate namespace and never change the attachment-only file handler. */
export function publicArtifactHandler(
  config: AssistantConfig,
  store: AssistantStore,
) {
  const files = fileLinkHandler(store);
  const pages = miniPageHandler(store);
  return (request: Request): Response => {
    if (new URL(request.url).pathname.startsWith('/p/')) {
      if (config.fileShares.enabled && config.miniPages?.enabled)
        return pages(request);
      return absent();
    }
    return files(request);
  };
}
