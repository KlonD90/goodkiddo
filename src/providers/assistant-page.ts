import http from 'node:http';
import https from 'node:https';
import { load } from 'cheerio';
import {
  publicUrl,
  resolvePublicUrl,
  PublicUrlError,
  type Address,
  type Resolver,
} from './public-url-policy.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 20_000;
export interface PageResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  bytes: Uint8Array;
}
export interface PageDependencies {
  resolve?: Resolver;
  request?: (
    url: URL,
    address: Address,
    signal: AbortSignal,
  ) => Promise<PageResponse>;
}

async function boundedResolution(
  url: URL,
  signal: AbortSignal,
  resolve?: Resolver,
): Promise<Address> {
  return new Promise((accept, reject) => {
    const abort = () =>
      reject(
        signal.reason || new PublicUrlError('Чтение страницы остановлено.'),
      );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    resolvePublicUrl(url, resolve)
      .then(accept, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

// Pin the socket to the validated DNS answer while retaining the URL hostname for TLS/SNI.
export function requestPage(
  url: URL,
  address: Address,
  signal: AbortSignal,
): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(
      url,
      {
        agent: false,
        signal,
        lookup: (_host, options, callback) => {
          if (typeof options === 'object' && options.all)
            callback(null, [
              { address: address.address, family: address.family },
            ]);
          else callback(null, address.address, address.family);
        },
        headers: {
          'User-Agent': 'GoodKiddo/0.2 page-reader',
          Accept: 'text/html,text/plain,application/json',
          'Accept-Encoding': 'identity',
        },
        maxHeaderSize: 16_384,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const length = Number(response.headers['content-length'] || 0);
        if (length > MAX_BYTES) {
          response.destroy(new PublicUrlError('Страница слишком велика.'));
        }
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES)
            response.destroy(new PublicUrlError('Страница слишком велика.'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            bytes: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on('error', reject);
  });
}

export function pageText(
  bytes: Uint8Array,
  contentType: string,
): { title: string; text: string; truncated: boolean } {
  if (bytes.byteLength > MAX_BYTES)
    throw new PublicUrlError('Страница слишком велика.');
  const source = new TextDecoder().decode(bytes);
  let title = '';
  let text = source;
  if (contentType.includes('html')) {
    const $ = load(source);
    title = $('title').first().text().trim().slice(0, 300);
    $(
      'script,style,iframe,object,embed,noscript,svg,form,nav,footer,header',
    ).remove();
    $('br').replaceWith('\n');
    $('p,div,section,article,h1,h2,h3,h4,li,tr,pre').append('\n');
    text = $('body').text();
  }
  text = text
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    title,
    text: text.slice(0, MAX_CHARS),
    truncated: text.length > MAX_CHARS,
  };
}

export async function readPublicPage(
  input: string,
  signal: AbortSignal,
  dependencies: PageDependencies = {},
) {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  let url = publicUrl(input);
  for (let redirects = 0; redirects <= 3; redirects++) {
    boundedSignal.throwIfAborted();
    const address = await boundedResolution(
      url,
      boundedSignal,
      dependencies.resolve,
    );
    boundedSignal.throwIfAborted();
    const response = await (dependencies.request || requestPage)(
      url,
      address,
      boundedSignal,
    );
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 3 || !response.headers.location)
        throw new PublicUrlError('Слишком много перенаправлений.');
      url = publicUrl(new URL(response.headers.location, url).href);
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new PublicUrlError(`Страница ответила HTTP ${response.status}.`);
    const type = String(response.headers['content-type'] || '').toLowerCase();
    if (!/^(text\/(html|plain)|application\/(json|xhtml\+xml))(;|$)/.test(type))
      throw new PublicUrlError(
        'Этот URL не содержит поддерживаемую текстовую страницу.',
      );
    if (
      response.headers['content-encoding'] &&
      response.headers['content-encoding'] !== 'identity'
    )
      throw new PublicUrlError('Сжатый ответ страницы не поддерживается.');
    return {
      url: url.href,
      ...pageText(response.bytes, type),
      untrusted: true as const,
    };
  }
  throw new PublicUrlError('Страница недоступна.');
}
