import { describe, expect, it, vi } from 'vitest';
import {
  isPublicAddress,
  publicUrl,
  resolvePublicUrl,
} from './public-url-policy.js';
import { readPublicPage, pageText } from './assistant-page.js';

describe('bounded public pages', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])('rejects nonpublic IP %s', (address) =>
    expect(isPublicAddress(address)).toBe(false),
  );
  it.each([
    'file:///etc/passwd',
    'http://localhost',
    'http://127.1',
    'http://2130706433',
    'http://[::1]',
    'https://a.example:8443',
    'https://user:password@a.example',
  ])('rejects unsafe URL %s', (url) => expect(() => publicUrl(url)).toThrow());
  it('rejects mixed DNS answers', async () => {
    await expect(
      resolvePublicUrl(publicUrl('https://example.com'), async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]),
    ).rejects.toThrow('DNS');
  });
  it('does not request a redirected private address', async () => {
    const request = vi.fn(
      async (_url: URL, _address: unknown, _signal: AbortSignal) => ({
        status: 302,
        headers: { location: 'http://169.254.169.254/latest' },
        bytes: new Uint8Array(),
      }),
    );
    await expect(
      readPublicPage('https://example.com', new AbortController().signal, {
        resolve: async () => [{ address: '8.8.8.8', family: 4 }],
        request,
      }),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toEqual({ address: '8.8.8.8', family: 4 });
  });
  it('extracts text without scripts or navigation', () => {
    const result = pageText(
      new TextEncoder().encode(
        '<title>Title</title><body><nav>nav</nav><script>secret()</script><p>A &amp; B</p><p>Next</p></body>',
      ),
      'text/html',
    );
    expect(result).toEqual({
      title: 'Title',
      text: 'A & B\nNext',
      truncated: false,
    });
  });
  it('bounds text and response bytes', () => {
    expect(
      pageText(new TextEncoder().encode('x'.repeat(20001)), 'text/plain')
        .truncated,
    ).toBe(true);
    expect(() =>
      pageText(new Uint8Array(2 * 1024 * 1024 + 1), 'text/plain'),
    ).toThrow('велика');
  });
});
