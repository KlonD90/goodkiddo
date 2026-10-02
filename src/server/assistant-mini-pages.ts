import type { AssistantStore } from '../persistence/assistant-store.js';
import { miniPage, miniPageAsset } from '../persistence/assistant-pages.js';
import {
  MINI_PAGE_ORIGIN,
  resourceUrl,
} from '../capabilities/pages/resources.js';

export { MINI_PAGE_ORIGIN } from '../capabilities/pages/resources.js';
export const MINI_PAGE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Content-Type': 'text/html; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-popups allow-popups-to-escape-sandbox",
};
export function miniPageUrl(token: string, sourcePath?: string): string {
  return sourcePath
    ? resourceUrl(token, sourcePath)
    : `${MINI_PAGE_ORIGIN}/p/${token}`;
}
export function miniPageHandler(
  store: AssistantStore,
  clock: () => number = Date.now,
) {
  let reading = 0;
  return (request: Request): Response => {
    try {
      const url = new URL(request.url);
      const match = /^\/p\/([A-Za-z0-9_-]{43})(\/[^\\\x00-\x1f]*)?$/.exec(
        url.pathname,
      );
      if (
        url.hostname !== new URL(MINI_PAGE_ORIGIN).hostname ||
        !match ||
        url.search
      )
        return absent();
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return new Response('Method not allowed', {
          status: 405,
          headers: { ...MINI_PAGE_HEADERS, Allow: 'GET, HEAD' },
        });
      const now = clock();
      const page = miniPage(store.db, match[1], now, false);
      if (!page) return absent();
      const path = match[2] ? decodeURIComponent(match[2]) : page.source_path;
      if (
        path.includes('..') ||
        path.includes('\\') ||
        /[\x00-\x1f]/.test(path)
      )
        return absent();
      const asset =
        path === page.source_path
          ? undefined
          : miniPageAsset(store.db, page, path, false);
      if (path !== page.source_path && !asset) return absent();
      const resource = asset || page;
      const source = `${MINI_PAGE_ORIGIN}/p/${match[1]}/`;
      const csp = MINI_PAGE_HEADERS['Content-Security-Policy']
        .replace(
          "style-src 'unsafe-inline'",
          `style-src 'unsafe-inline' ${source}`,
        )
        .replace(
          'img-src data:',
          `img-src data: ${source}; font-src ${source}`,
        );
      const headers: Record<string, string> = {
        ...MINI_PAGE_HEADERS,
        'Content-Security-Policy': csp,
        'Content-Type': asset?.mime_type || MINI_PAGE_HEADERS['Content-Type'],
        'Content-Length': String(resource.size),
        ...(asset ? { 'Cross-Origin-Resource-Policy': 'cross-origin' } : {}),
        ...(asset?.mime_type.startsWith('font/')
          ? { 'Access-Control-Allow-Origin': '*' }
          : {}),
      };
      if (request.method === 'HEAD') return new Response(null, { headers });
      if (reading >= 4)
        return new Response(null, {
          status: 503,
          headers: { ...headers, 'Retry-After': '2', 'Content-Length': '0' },
        });
      const content = asset
        ? miniPageAsset(store.db, page, path, true)?.content
        : miniPage(store.db, match[1], now, true)?.content;
      if (!content) return absent();
      reading++;
      let offset = 0;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          reading--;
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
        cancel: release,
      });
      return new Response(body, { headers });
    } catch {
      return absent();
    }
  };
}
function absent(): Response {
  return new Response('Мини-страница недоступна.', {
    status: 404,
    headers: {
      ...MINI_PAGE_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
