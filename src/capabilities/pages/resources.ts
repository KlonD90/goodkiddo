import { posix } from 'node:path';
import { fileText } from '../../persistence/assistant-file-policy.js';

export const MINI_PAGE_ORIGIN = 'https://whosagoodkiddo.me';
export const MAX_PAGE_ASSETS = 40;
export const MAX_PAGE_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_PAGE_BUNDLE_BYTES = 5 * 1024 * 1024;
export interface MiniPageAsset {
  path: string;
  mimeType: string;
  content: Uint8Array;
}
export type ResourceKind = 'html' | 'css' | 'image' | 'font';

export function resourcePath(
  from: string,
  reference: string,
): string | undefined {
  if (
    !reference ||
    /^[\s#]|^[a-z][a-z0-9+.-]*:|^\/\//i.test(reference) ||
    /[\\\x00-\x1f]/.test(reference)
  )
    return undefined;
  try {
    const raw = decodeURIComponent(reference.split(/[?#]/)[0]);
    if (!raw || /[\\\x00-\x1f]/.test(raw)) return undefined;
    return posix.resolve(posix.dirname(from), raw);
  } catch {
    return undefined;
  }
}
export function resourceUrl(token: string, path: string): string {
  return `${MINI_PAGE_ORIGIN}/p/${token}${path
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
      ),
    )
    .join('/')}`;
}
export function resourceKind(path: string): ResourceKind | undefined {
  const extension = posix.extname(path).toLowerCase();
  if (['.html', '.htm'].includes(extension)) return 'html';
  if (extension === '.css') return 'css';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension))
    return 'image';
  if (['.woff', '.woff2'].includes(extension)) return 'font';
  return undefined;
}
export function staticAsset(path: string, content: Uint8Array): MiniPageAsset {
  if (!content.length || content.length > MAX_PAGE_ASSET_BYTES)
    throw new Error(
      'Каждый ассет мини-страницы должен занимать от 1 байта до 2 МиБ.',
    );
  const extension = posix.extname(path).toLowerCase();
  const bytes = Buffer.from(content);
  let mimeType: string | undefined;
  if (extension === '.css') {
    fileText(content);
    mimeType = 'text/css; charset=utf-8';
  }
  if (['.html', '.htm'].includes(extension)) {
    fileText(content);
    mimeType = 'text/html; charset=utf-8';
  }
  if (
    extension === '.png' &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    mimeType = 'image/png';
  if (
    ['.jpg', '.jpeg'].includes(extension) &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    mimeType = 'image/jpeg';
  if (
    extension === '.gif' &&
    /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString())
  )
    mimeType = 'image/gif';
  if (
    extension === '.webp' &&
    bytes.subarray(0, 4).toString() === 'RIFF' &&
    bytes.subarray(8, 12).toString() === 'WEBP'
  )
    mimeType = 'image/webp';
  if (extension === '.woff' && bytes.subarray(0, 4).toString() === 'wOFF')
    mimeType = 'font/woff';
  if (extension === '.woff2' && bytes.subarray(0, 4).toString() === 'wOF2')
    mimeType = 'font/woff2';
  if (!mimeType)
    throw new Error(
      'Ассет должен быть CSS, HTML, корректным PNG/JPEG/GIF/WebP или WOFF/WOFF2. JavaScript и SVG не публикуются.',
    );
  return { path, content, mimeType };
}

/** Unsupported references stay inert; no network or VFS lookup is performed. */
export function rewriteCss(
  input: string,
  resolve: (value: string) => string | undefined,
): string {
  return input
    .replace(
      /url\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s)'"\\]+))\s*\)/gi,
      (_, double: string, single: string, bare: string) =>
        `url("${resolve(double ?? single ?? bare) || ''}")`,
    )
    .replace(
      /@import\s+(["'])([^"'\r\n]+)\1/gi,
      (_, quote: string, value: string) =>
        `@import ${quote}${resolve(value) || ''}${quote}`,
    );
}
