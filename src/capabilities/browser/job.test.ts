import { describe, it, expect, vi } from 'vitest';
import { BrowserNetworkPolicy } from './network-policy.js';
import {
  BrowserSlots,
  ReadOnlyBrowserJob,
  BROWSER_ACTION_POLICY,
  type BrowserWorker,
} from './job.js';
import { browserResearchTools } from './tools.js';

function setup(
  overrides: Partial<BrowserWorker> = {},
  slots = new BrowserSlots(),
) {
  let url = 'https://example.com/';
  const run = vi.fn(async (input: Parameters<BrowserWorker['run']>[0]) => {
    const command = input.argv.slice(7);
    if (command[0] === 'open') url = command[1];
    let stdout = '';
    if (command.join(' ') === 'get url') stdout = url;
    if (command[0] === 'snapshot') stdout = 'heading Synthetic\nlink @e1 More';
    if (command[1] === 'attr') stdout = '/more';
    return { stdout, stderr: '', exitCode: 0 };
  });
  const dispose = vi.fn(async () => {});
  const worker = { run, dispose, ...overrides };
  const factory = vi.fn(() => worker);
  const policy = new BrowserNetworkPolicy(['https://example.com'], async () => [
    { address: '8.8.8.8', family: 4 },
  ]);
  const cancel = new AbortController();
  const job = new ReadOnlyBrowserJob(factory, policy, cancel.signal, slots, {
    chatId: 'synthetic-chat',
    taskId: 'synthetic-task',
  });
  return { job, factory, worker, run, dispose, slots, cancel };
}

describe('inactive read-only browser adapter', () => {
  it('uses a new opaque job, strict policy and canonical URLs', async () => {
    const s = setup();
    expect(s.factory).not.toHaveBeenCalled();
    expect(await s.job.snapshot('https://example.com/#fragment')).toMatchObject(
      {
        url: 'https://example.com/',
        untrusted: true,
      },
    );
    expect(s.factory.mock.calls[0][0]).toMatchObject({
      actionPolicy: BROWSER_ACTION_POLICY,
    });
    expect(s.run.mock.calls[0][0].destination?.address.address).toBe('8.8.8.8');
    expect(s.run.mock.calls[0][0].argv.at(-1)).toBe('https://example.com/');
    expect(s.job.id).not.toContain('synthetic-chat');
    await s.job.close();
    expect(s.dispose).toHaveBeenCalledTimes(1);
    expect(s.slots.count()).toBe(0);
    await expect(s.job.snapshot('https://example.com')).rejects.toThrow();
  });
  it('follows hrefs without dispatching clicks', async () => {
    const s = setup();
    await s.job.snapshot('https://example.com');
    expect((await s.job.followLink('@e1')).url).toBe(
      'https://example.com/more',
    );
    expect(
      s.run.mock.calls.every(([input]) => !input.argv.includes('click')),
    ).toBe(true);
    await s.job.close();
  });
  it('rejects foreign/unsafe links before opening them', async () => {
    const s = setup({
      run: vi.fn(async ({ argv }) => ({
        stdout: argv.includes('attr')
          ? 'http://127.0.0.1/'
          : argv.includes('url')
            ? 'https://example.com'
            : '',
        stderr: '',
        exitCode: 0,
      })),
    });
    await s.job.snapshot('https://example.com');
    await expect(s.job.followLink('@e1')).rejects.toThrow();
    expect(s.worker.run).toHaveBeenCalledTimes(4);
    await s.job.close();
  });
  it('does not read redirected private pages', async () => {
    const s = setup({
      run: vi.fn(async ({ argv }) => ({
        stdout: argv.includes('url') ? 'http://169.254.169.254/' : '',
        stderr: '',
        exitCode: 0,
      })),
    });
    await expect(s.job.snapshot('https://example.com')).rejects.toThrow();
    expect(s.worker.run).toHaveBeenCalledTimes(2);
    await s.job.close();
  });
  it.each([
    { action: 'click', ref: '@e1' },
    { action: 'fill', ref: '@e1', text: 'secret' },
    { action: 'wait', untilFn: 'fetch("http://localhost")' },
    { action: 'scroll', direction: 'down', amount: 500, sessionKey: 'foreign' },
  ])('rejects disallowed action %j', async (action) => {
    const s = setup();
    const tool = browserResearchTools(s.job)[1];
    await expect(
      Promise.resolve().then(() => tool.execute(action, s.cancel.signal)),
    ).rejects.toThrow();
    expect(s.factory).not.toHaveBeenCalled();
    await s.job.close();
  });
  it('cancels a stalled worker then waits for cleanup', async () => {
    const s = setup({ run: async () => new Promise(() => {}) });
    const pending = s.job.snapshot('https://example.com');
    await vi.waitFor(() => expect(s.factory).toHaveBeenCalled());
    s.cancel.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    await s.job.close();
    expect(s.dispose).toHaveBeenCalled();
    expect(s.slots.count()).toBe(0);
  });
  it('quarantines capacity when cleanup cannot be confirmed', async () => {
    const slots = new BrowserSlots(1);
    const s = setup(
      {
        dispose: async () => {
          throw new Error('cleanup failed');
        },
      },
      slots,
    );
    await s.job.snapshot('https://example.com');
    await expect(s.job.close()).rejects.toThrow('cleanup failed');
    expect(slots.count()).toBe(1);
    expect(() => setup({}, slots)).toThrow('capacity');
  });
  it('caps transport output', async () => {
    const s = setup({
      run: async () => ({
        stdout: 'x'.repeat(128 * 1024 + 1),
        stderr: '',
        exitCode: 0,
      }),
    });
    await expect(s.job.snapshot('https://example.com')).rejects.toThrow(
      'transport',
    );
    await s.job.close();
  });
  it('limits global capacity to two jobs with unique state', async () => {
    const slots = new BrowserSlots();
    const a = setup({}, slots);
    const b = setup({}, slots);
    expect(a.job.id).not.toBe(b.job.id);
    expect(() => setup({}, slots)).toThrow('capacity');
    await a.job.close();
    await b.job.close();
  });
});
