import { BrowserNetworkPolicy } from '../capabilities/browser/network-policy.js';
import {
  requestPage,
  type PageDependencies,
} from '../providers/assistant-page.js';
import type { FetchResponse } from './protocol.js';

const MAX_REQUESTS = 40;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const HEADERS = new Set([
  'content-type',
  'location',
  'content-security-policy',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-expose-headers',
  'cross-origin-resource-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'x-frame-options',
]);

export class BrowserEgress {
  private requests = 0;
  private bytes = 0;
  private active = 0;
  readonly policy: BrowserNetworkPolicy;
  constructor(private readonly dependencies: PageDependencies = {}) {
    this.policy = new BrowserNetworkPolicy([], dependencies.resolve, {
      publicBrowsing: true,
    });
  }
  async fetch(
    url: string,
    method: string,
    signal: AbortSignal,
  ): Promise<FetchResponse> {
    if (++this.requests > MAX_REQUESTS || this.active >= 4)
      throw new Error('Browser request limit reached.');
    this.active++;
    try {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const destination = await this.policy.authorize(url, method, bounded);
      // The socket lookup is pinned to the validated IP while preserving hostname/SNI.
      // Never forward browser headers, cookies, authorization, upload data or request bodies.
      const response = await (this.dependencies.request || requestPage)(
        new URL(destination.url),
        destination.address,
        bounded,
      );
      if (
        response.headers['content-encoding'] &&
        response.headers['content-encoding'] !== 'identity'
      )
        throw new Error('Compressed browser response is unsupported.');
      this.bytes += response.bytes.length;
      if (this.bytes > MAX_TOTAL_BYTES)
        throw new Error('Browser byte budget reached.');
      if (response.bytes.length > 2 * 1024 * 1024)
        throw new Error('Browser resource too large.');
      const headers = Object.entries(response.headers).flatMap(
        ([name, value]) => {
          if (!HEADERS.has(name.toLowerCase()) || value === undefined)
            return [];
          const text = Array.isArray(value) ? value.join(', ') : String(value);
          if (/\r|\n/.test(text) || text.length > 8192) return [];
          return [{ name, value: text }];
        },
      );
      return {
        status: response.status,
        headers,
        body:
          method === 'HEAD'
            ? ''
            : Buffer.from(response.bytes).toString('base64'),
      };
    } finally {
      this.active--;
    }
  }
}
