import { randomBytes } from 'node:crypto';
import { load } from 'cheerio';
import { sanitizeMiniPage, MAX_MINI_PAGE_BYTES } from './html.js';
import {
  fileText,
  textBytes,
} from '../../persistence/assistant-file-policy.js';
import {
  resourceKind,
  resourcePath,
  resourceUrl,
  rewriteCss,
  staticAsset,
  MAX_PAGE_ASSETS,
  type MiniPageAsset,
} from './resources.js';

export interface PageSource {
  path: string;
  content: Uint8Array;
}
export function preparePageBundle(
  primary: PageSource,
  selections: PageSource[],
  title: string,
  token = randomBytes(32).toString('base64url'),
) {
  const unique = new Map(selections.map((file) => [file.path, file]));
  unique.delete(primary.path);
  const assets = [...unique.values()].map((file) =>
    staticAsset(file.path, file.content),
  );
  if (assets.length > MAX_PAGE_ASSETS)
    throw new Error('Выберите не больше 40 ассетов.');
  const available = new Set([
    primary.path,
    ...assets.map((asset) => asset.path),
  ]);
  const options = (from: string) => ({
    resource: (reference: string, kind: 'style' | 'image' | 'navigation') => {
      const path = resourcePath(from, reference);
      if (!path || !available.has(path)) return undefined;
      const type = resourceKind(path);
      if (
        (kind === 'style' && type !== 'css') ||
        (kind === 'image' && type !== 'image') ||
        (kind === 'navigation' && type !== 'html')
      )
        return undefined;
      return (
        resourceUrl(token, path) +
        (reference.includes('#')
          ? '#' + encodeURIComponent(reference.split('#')[1])
          : '')
      );
    },
    css: (value: string) =>
      rewriteCss(value, (reference) => {
        const path = resourcePath(from, reference);
        return path && available.has(path) && resourceKind(path) !== 'html'
          ? resourceUrl(token, path)
          : undefined;
      }),
  });
  const prepared = sanitizeMiniPage(
    fileText(primary.content),
    title,
    options(primary.path),
  );
  const bounded: MiniPageAsset[] = assets.map((asset) => {
    const kind = resourceKind(asset.path);
    const content =
      kind === 'html'
        ? textBytes(
            sanitizeMiniPage(
              fileText(asset.content),
              title,
              options(asset.path),
            ).html,
          )
        : kind === 'css'
          ? textBytes(options(asset.path).css(fileText(asset.content)))
          : asset.content;
    return { ...asset, content };
  });
  return { ...prepared, assets: bounded, token };
}

/** Follow only references present in the selected immutable snapshot; never open the VFS. */
export function referencedAssets(
  primary: PageSource,
  sources: Map<string, PageSource>,
): PageSource[] {
  const selected = new Map<string, PageSource>([[primary.path, primary]]);
  const queue = [primary];
  for (const file of queue) {
    const add = (reference: string) => {
      const path = resourcePath(file.path, reference);
      const found = path && resourceKind(path) ? sources.get(path) : undefined;
      if (!found || selected.has(found.path)) return undefined;
      selected.set(found.path, found);
      if (selected.size > MAX_PAGE_ASSETS + 1)
        throw new Error('HTML preview ссылается больше чем на 40 ассетов.');
      if (['html', 'css'].includes(resourceKind(found.path)!))
        queue.push(found);
      return reference;
    };
    // Bound parsing before Cheerio allocates a tree for a selected HTML file.
    if (
      resourceKind(file.path) === 'html' &&
      file.content.length > MAX_MINI_PAGE_BYTES
    )
      throw new Error('HTML мини-страницы превышает 256 КиБ.');
    staticAsset(file.path, file.content);
    const text = fileText(file.content);
    if (resourceKind(file.path) === 'css') {
      rewriteCss(text, add);
      continue;
    }
    const $ = load(text);
    $('[href],[src]').each((_, node) => {
      add($(node).attr('href') || '');
      add($(node).attr('src') || '');
    });
    $('style,[style]').each((_, node) => {
      rewriteCss($(node).attr('style') || $(node).text(), add);
    });
  }
  return [...selected.values()].filter((file) => file.path !== primary.path);
}
