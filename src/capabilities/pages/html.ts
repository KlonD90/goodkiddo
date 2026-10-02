import { load } from 'cheerio';

export const MAX_MINI_PAGE_BYTES = 256 * 1024;
const tags = new Set(
  (
    'html head body style main article section header footer nav aside div span p ' +
    'h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table caption thead tbody tfoot tr th td ' +
    'a img figure figcaption blockquote pre code strong em b i u s small sub sup ' +
    'br hr details summary time abbr address'
  ).split(' '),
);
const attributes = new Set([
  'id',
  'class',
  'style',
  'title',
  'lang',
  'dir',
  'role',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-hidden',
]);
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]!,
  );
}
function safeHref(value: string): string | undefined {
  if (/^#[A-Za-z0-9_-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password)
      return url.href;
  } catch {}
  return undefined;
}

/** Parse first, then serialize an allowlist. CSP separately blocks all active/network content. */
export function sanitizeMiniPage(input: string, title: string) {
  if (!input.trim() || Buffer.byteLength(input) > MAX_MINI_PAGE_BYTES)
    throw new Error(
      'HTML мини-страницы должен занимать от 1 байта до 256 КиБ.',
    );
  if (!title.trim() || title.length > 160 || /[\x00-\x1f\x7f]/.test(title))
    throw new Error('Название мини-страницы — от 1 до 160 символов.');
  const $ = load(input);
  let removed = 0;
  $('*').each((_, element) => {
    if (!('name' in element) || !('attribs' in element)) return;
    if (!tags.has(element.name)) {
      $(element).remove();
      removed++;
      return;
    }
    const node = $(element);
    const href =
      element.name === 'a' ? safeHref(node.attr('href') || '') : undefined;
    const src =
      element.name === 'img' &&
      /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/i.test(
        node.attr('src') || '',
      )
        ? node.attr('src')
        : undefined;
    for (const [name] of Object.entries(element.attribs)) {
      const extra =
        (element.name === 'img' && ['alt', 'width', 'height'].includes(name)) ||
        (['td', 'th'].includes(element.name) &&
          ['colspan', 'rowspan', 'scope'].includes(name)) ||
        (element.name === 'details' && name === 'open');
      if (!attributes.has(name) && !extra) {
        node.removeAttr(name);
        removed++;
      }
    }
    if (href) {
      node.attr('href', href);
      if (!href.startsWith('#'))
        node.attr('target', '_blank').attr('rel', 'noopener noreferrer');
    }
    if (src) node.attr('src', src);
  });
  $('head').prepend(
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title.trim())}</title>`,
  );
  const html = '<!doctype html>' + $('html').toString();
  if (Buffer.byteLength(html) > MAX_MINI_PAGE_BYTES)
    throw new Error('Готовая мини-страница превышает 256 КиБ. Сократите HTML.');
  return { html, removed };
}
