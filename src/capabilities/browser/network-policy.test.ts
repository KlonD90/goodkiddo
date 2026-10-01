import { describe, it, expect, vi } from 'vitest';
import { BrowserNetworkPolicy } from './network-policy.js';

const signal = () => new AbortController().signal;
const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];

describe('browser connection policy', () => {
  it('returns a validated address for a worker to pin its socket to', async () => {
    const policy = new BrowserNetworkPolicy(['https://example.com'], publicDns);
    expect(
      await policy.authorize('https://example.com/a#frag', 'GET', signal()),
    ).toEqual({
      url: 'https://example.com/a',
      hostname: 'example.com',
      address: { address: '8.8.8.8', family: 4 },
    });
  });
  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS', 'CONNECT'])(
    'blocks %s before DNS',
    async (method) => {
      const resolve = vi.fn(publicDns);
      const policy = new BrowserNetworkPolicy(['https://example.com'], resolve);
      await expect(
        policy.authorize('https://example.com', method, signal()),
      ).rejects.toThrow('GET/HEAD');
      expect(resolve).not.toHaveBeenCalled();
    },
  );
  it.each([
    'http://127.1',
    'http://169.254.169.254',
    'file:///etc/passwd',
    'https://user:secret@example.com',
    'https://example.com:8443',
    'wss://example.com/socket',
    'https://evil.example.com',
  ])('blocks redirect/resource %s', async (url) => {
    const policy = new BrowserNetworkPolicy(['https://example.com'], publicDns);
    await expect(policy.authorize(url, 'GET', signal())).rejects.toThrow();
  });
  it('rechecks every connection, detecting DNS rebinding', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(await publicDns())
      .mockResolvedValueOnce([{ address: '10.1.2.3', family: 4 }]);
    const policy = new BrowserNetworkPolicy(['https://example.com'], resolve);
    await policy.authorize('https://example.com/a', 'GET', signal());
    await expect(
      policy.authorize('https://example.com/b', 'HEAD', signal()),
    ).rejects.toThrow('DNS');
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it('rejects a mixed public/private answer for an approved CDN', async () => {
    const policy = new BrowserNetworkPolicy(
      ['https://example.com', 'https://cdn.example.com'],
      async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '::1', family: 6 },
      ],
    );
    await expect(
      policy.authorize('https://cdn.example.com/a.js', 'GET', signal()),
    ).rejects.toThrow('DNS');
  });
  it('bounds a stalled resolver with cancellation', async () => {
    const policy = new BrowserNetworkPolicy(
      ['https://example.com'],
      () => new Promise(() => {}),
    );
    const cancel = new AbortController();
    const request = policy.authorize(
      'https://example.com',
      'GET',
      cancel.signal,
    );
    cancel.abort(new Error('cancelled'));
    await expect(request).rejects.toThrow('cancelled');
  });
  it('does not accept wildcard or empty origins', () => {
    expect(() => new BrowserNetworkPolicy([], publicDns)).toThrow();
    expect(
      () => new BrowserNetworkPolicy(['https://*.example.com'], publicDns),
    ).toThrow();
  });
});
