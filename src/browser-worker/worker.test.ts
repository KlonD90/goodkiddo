import net from 'node:net';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserEgress } from './egress.js';
import { createBrowserBroker } from './broker.js';
import { socketBrowserFactory } from './client.js';
import { containerArgs, type BrokerJob } from './container.js';
import { parseCommand, requestSchema } from './protocol.js';
import { BrowserNetworkPolicy } from '../capabilities/browser/network-policy.js';
import {
  BrowserSlots,
  ReadOnlyBrowserJob,
} from '../capabilities/browser/job.js';
import type { PageDependencies } from '../providers/assistant-page.js';

const signal = () => new AbortController().signal;
const dns = async () => [{ address: '8.8.8.8', family: 4 }];
const image = 'localhost/goodkiddo-browser:012345abcdef';
const jobId = 'research-00000000-0000-4000-8000-000000000001';
const prefix = [
  '--session',
  jobId,
  '--allowed-domains',
  'example.com',
  '--content-boundaries',
  '--max-output',
  '20000',
];

describe('isolated browser command and egress boundary', () => {
  it('matches the pinned vendor raw actions without granting interactions', () => {
    const policy = JSON.parse(
      readFileSync(
        new URL(
          '../../runners/browser-worker/action-policy.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(policy.default).toBe('deny');
    expect(policy.allow.sort()).toEqual(
      [
        'launch',
        'navigate',
        'snapshot',
        'url',
        'gettext',
        'getattribute',
        'scroll',
      ].sort(),
    );
    expect(() => parseCommand([...prefix, 'launch'], jobId)).toThrow();
  });
  it('accepts only fixed read commands, never shell flags or browser sessions', () => {
    expect(
      parseCommand([...prefix, 'open', 'https://example.com'], jobId),
    ).toEqual({ action: 'open', url: 'https://example.com/' });
    for (const args of [
      ['click', '@e1'],
      ['eval', 'fetch("localhost")'],
      ['--cdp', 'http://localhost'],
      ['get', 'attr', '@e1', 'onclick'],
    ])
      expect(() => parseCommand([...prefix, ...args], jobId)).toThrow();
    expect(() =>
      requestSchema.parse({
        type: 'command',
        id: 1,
        command: {
          action: 'open',
          url: 'https://example.com',
          session: 'foreign',
        },
      }),
    ).toThrow();
  });
  it('fixes container CPU/RAM/time, network and filesystem controls without host mounts', () => {
    const args = containerArgs(
      'goodkiddo-browser-00000000-0000-4000-8000-000000000001',
      image,
      '/opt/goodkiddo-browser/seccomp.json',
    );
    for (const flag of [
      '--timeout=60',
      '--network=none',
      '--read-only',
      '--user=1000:1000',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--cpus=1',
      '--memory=1g',
      '--memory-swap=1g',
      '--ipc=private',
    ])
      expect(args).toContain(flag);
    expect(
      args.some((arg) =>
        /^(--privileged|--volume|--mount|--publish|--network=host)/.test(arg),
      ),
    ).toBe(false);
    expect(() => containerArgs('foreign', image, '/etc/seccomp')).toThrow();
  });
  it('pins the validated DNS answer and strips cookies and hop-by-hop headers', async () => {
    const request = vi.fn<NonNullable<PageDependencies['request']>>(
      async () => ({
        status: 200,
        headers: {
          'content-type': 'text/html',
          'set-cookie': ['secret=1'],
          connection: 'keep-alive',
        },
        bytes: Buffer.from('Synthetic'),
      }),
    );
    const egress = new BrowserEgress({ resolve: dns, request });
    const result = await egress.fetch('https://example.com/a', 'GET', signal());
    expect(request.mock.calls[0][1]).toEqual({ address: '8.8.8.8', family: 4 });
    expect(result.headers).toEqual([
      { name: 'content-type', value: 'text/html' },
    ]);
  });
  it('blocks private literals, mixed DNS, rebinding, redirects and writes before socket creation', async () => {
    const request = vi.fn(async () => ({
      status: 302,
      headers: { location: 'http://169.254.169.254/' },
      bytes: new Uint8Array(),
    }));
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(await dns())
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    const egress = new BrowserEgress({ resolve, request });
    await egress.fetch('https://example.com/a', 'GET', signal());
    for (const url of [
      'http://127.1/',
      'http://169.254.169.254/',
      'file:///etc/passwd',
    ])
      await expect(egress.fetch(url, 'GET', signal())).rejects.toThrow();
    await expect(
      egress.fetch('https://example.com/b', 'GET', signal()),
    ).rejects.toThrow('DNS');
    await expect(
      egress.fetch('https://example.com', 'POST', signal()),
    ).rejects.toThrow('GET/HEAD');
    expect(request).toHaveBeenCalledTimes(1);
    const mixed = new BrowserEgress({
      resolve: async () => [...(await dns()), { address: '::1', family: 6 }],
      request,
    });
    await expect(
      mixed.fetch('https://example.com', 'GET', signal()),
    ).rejects.toThrow('DNS');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('bounds bytes, request count and approved public domains', async () => {
    const oversized = new BrowserEgress({
      resolve: dns,
      request: async () => ({
        status: 200,
        headers: {},
        bytes: new Uint8Array(2 * 1024 * 1024 + 1),
      }),
    });
    await expect(
      oversized.fetch('https://example.com', 'GET', signal()),
    ).rejects.toThrow('too large');
    const egress = new BrowserEgress({
      resolve: dns,
      request: async () => ({
        status: 200,
        headers: {},
        bytes: new Uint8Array(),
      }),
    });
    for (let n = 0; n < 40; n++)
      await egress.fetch('https://example.com', 'GET', signal());
    await expect(
      egress.fetch('https://example.com', 'GET', signal()),
    ).rejects.toThrow('limit');
    const policy = new BrowserNetworkPolicy([], dns, { publicBrowsing: true });
    for (let n = 0; n < 8; n++)
      await policy.authorize(`https://source${n}.example.com`, 'GET', signal());
    await expect(
      policy.authorize('https://ninth.example.com', 'GET', signal()),
    ).rejects.toThrow('domain limit');
  });
});

let root: string | undefined;
let server: net.Server | undefined;
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  server = undefined;
});
async function broker(factory: (id: string, release: () => void) => BrokerJob) {
  root = await mkdtemp(join(tmpdir(), 'browser-broker-check-'));
  const path = join(root, 'worker.sock');
  server = createBrowserBroker(image, factory);
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(path, resolve);
  });
  return socketBrowserFactory('/run/goodkiddo-browser/worker.sock', () => {
    const socket = net.createConnection(path);
    sockets.push(socket);
    return socket;
  });
}
function newJob(
  factory: ReturnType<typeof socketBrowserFactory>,
  cancel = new AbortController(),
) {
  return new ReadOnlyBrowserJob(
    factory,
    new BrowserNetworkPolicy(['https://example.com'], dns),
    cancel.signal,
    new BrowserSlots(1),
    { chatId: 'synthetic', taskId: 'synthetic-task' },
  );
}

describe('private browser broker lifecycle with synthetic workers', () => {
  it('serializes global capacity, scopes commands to one connection and creates fresh state', async () => {
    const closed = vi.fn();
    const jobs: string[] = [];
    const factory = await broker((id) => {
      jobs.push(id);
      let url = 'about:blank';
      return {
        run: async (command) => {
          if (command.action === 'open') url = command.url;
          return command.action === 'get_url' ? url : 'heading Synthetic';
        },
        close: async () => {
          closed();
        },
      };
    });
    const first = newJob(factory);
    await first.snapshot('https://example.com/first');
    const second = newJob(factory);
    await expect(
      second.snapshot('https://example.com/foreign'),
    ).rejects.toThrow('unavailable');
    await second.close();
    await first.close();
    const next = newJob(factory);
    expect((await next.snapshot('https://example.com/fresh')).url).toContain(
      '/fresh',
    );
    await next.close();
    expect(jobs.length).toBe(2);
    expect(new Set(jobs).size).toBe(2);
    expect(closed).toHaveBeenCalled();
  });
  it('accepts cancellation during a command and confirms cleanup before releasing capacity', async () => {
    let rejectRun: ((error: Error) => void) | undefined;
    let first = true;
    const closed = vi.fn();
    const factory = await broker(() => ({
      run: async (command) => {
        if (first)
          return new Promise<string>((_, reject) => {
            rejectRun = reject;
          });
        return command.action === 'get_url'
          ? 'https://example.com/'
          : 'Synthetic';
      },
      close: async () => {
        closed();
        rejectRun?.(new Error('Stopped'));
        first = false;
      },
    }));
    const cancel = new AbortController();
    const job = newJob(factory, cancel);
    const pending = job.snapshot('https://example.com');
    await vi.waitFor(() => expect(rejectRun).toBeDefined());
    cancel.abort(new Error('synthetic cancellation'));
    await expect(pending).rejects.toThrow('synthetic cancellation');
    await job.close();
    expect(closed).toHaveBeenCalled();
    const next = newJob(factory);
    await next.snapshot('https://example.com');
    await next.close();
  });
});
