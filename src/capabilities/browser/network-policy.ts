import {
  publicUrl,
  resolvePublicUrl,
  type Address,
  type Resolver,
} from '../../providers/public-url-policy.js';
import { isIP } from 'node:net';

export interface BrowserDestination {
  url: string;
  address: Address;
  hostname: string;
}

// This gate must be called by the worker for EVERY connection, including redirects,
// frames, workers and subresources. A navigation-only check is not SSRF protection.
export class BrowserNetworkPolicy {
  readonly domains: readonly string[];
  constructor(
    approvedUrls: string[],
    private readonly resolve?: Resolver,
  ) {
    if (!approvedUrls.length || approvedUrls.length > 8)
      throw new Error('Browser needs one to eight approved public origins.');
    this.domains = Object.freeze([
      ...new Set(approvedUrls.map((url) => publicUrl(url).hostname)),
    ]);
    if (
      this.domains.some(
        (host) =>
          !isIP(host.replace(/^\[|\]$/g, '')) &&
          !host
            .split('.')
            .every((label) =>
              /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
            ),
      )
    )
      throw new Error('Only exact public domain names are approved.');
  }

  async authorize(
    input: string,
    method: string,
    signal: AbortSignal,
  ): Promise<BrowserDestination> {
    signal.throwIfAborted();
    if (!['GET', 'HEAD'].includes(method))
      throw new Error('Read-only browsing permits GET/HEAD only.');
    const url = publicUrl(input);
    if (!this.domains.includes(url.hostname))
      throw new Error('Browser destination is outside the approved domains.');
    const address = await abortable(
      resolvePublicUrl(url, this.resolve),
      signal,
    );
    return { url: url.href, hostname: url.hostname, address };
  }
}

export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Browser stopped.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
