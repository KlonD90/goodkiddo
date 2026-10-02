import type { AssistantStore } from '../persistence/assistant-store.js';
import { miniPage } from '../persistence/assistant-pages.js';

export const MINI_PAGE_ORIGIN = 'https://whosagoodkiddo.me';
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
export function miniPageUrl(token: string): string {
  return `${MINI_PAGE_ORIGIN}/p/${token}`;
}
export function miniPageHandler(
  store: AssistantStore,
  clock: () => number = Date.now,
) {
  return (request: Request): Response => {
    try {
      const url = new URL(request.url);
      const match = /^\/p\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
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
      const page = miniPage(
        store.db,
        match[1],
        clock(),
        request.method !== 'HEAD',
      );
      if (!page) return absent();
      return new Response(request.method === 'HEAD' ? null : page.content, {
        headers: { ...MINI_PAGE_HEADERS, 'Content-Length': String(page.size) },
      });
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
