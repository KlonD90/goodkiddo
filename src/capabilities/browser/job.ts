import { randomUUID } from 'node:crypto';
import { BrowserNetworkPolicy, abortable } from './network-policy.js';

export const BROWSER_LIMITS = Object.freeze({
  jobMs: 60_000,
  commandMs: 15_000,
  cleanupMs: 5_000,
  commands: 12,
  outputChars: 20_000,
  totalOutputChars: 60_000,
  transportBytes: 128 * 1024,
});

export const BROWSER_ACTION_POLICY = Object.freeze({
  default: 'deny',
  allow: ['navigate', 'snapshot', 'scroll', 'get'],
});

// Implementations belong in an approved isolated worker, NOT in the bot process.
// No default implementation spawns processes or contacts a browser service.
export interface BrowserWorker {
  run(input: {
    argv: readonly string[];
    destination?: Awaited<ReturnType<BrowserNetworkPolicy['authorize']>>;
    signal: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  // Return only once Chrome/daemon children are gone and ephemeral state is removed.
  dispose(signal: AbortSignal): Promise<void>;
}
export type BrowserWorkerFactory = (input: {
  jobId: string;
  network: BrowserNetworkPolicy;
  limits: typeof BROWSER_LIMITS;
  actionPolicy: typeof BROWSER_ACTION_POLICY;
  signal: AbortSignal;
}) => BrowserWorker;

export class BrowserSlots {
  private active = 0;
  constructor(private readonly maximum = 2) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 2)
      throw new Error('Browser concurrency must be one or two.');
  }
  acquire(): () => void {
    if (this.active >= this.maximum)
      throw new Error('Browser capacity reached.');
    this.active++;
    let released = false;
    return () => {
      if (!released) this.active--;
      released = true;
    };
  }
  count(): number {
    return this.active;
  }
}

export class ReadOnlyBrowserJob {
  readonly id = `research-${randomUUID()}`;
  private worker?: BrowserWorker;
  private commands = 0;
  private output = 0;
  private busy = false;
  private closed = false;
  private currentUrl?: string;
  private readonly cancel = new AbortController();
  private readonly signal: AbortSignal;
  private readonly release: () => void;

  constructor(
    private readonly factory: BrowserWorkerFactory,
    readonly network: BrowserNetworkPolicy,
    signal: AbortSignal,
    slots: BrowserSlots,
    readonly owner: Readonly<{ chatId: string; taskId: string }>,
  ) {
    this.owner = Object.freeze({ ...owner });
    this.signal = AbortSignal.any([
      signal,
      this.cancel.signal,
      AbortSignal.timeout(BROWSER_LIMITS.jobMs),
    ]);
    this.release = slots.acquire();
  }

  private async command(args: string[], url?: string): Promise<string> {
    this.signal.throwIfAborted();
    if (this.closed || this.busy)
      throw new Error('Browser job is unavailable.');
    if (++this.commands > BROWSER_LIMITS.commands)
      throw new Error('Browser command limit reached.');
    this.busy = true;
    const signal = AbortSignal.any([
      this.signal,
      AbortSignal.timeout(BROWSER_LIMITS.commandMs),
    ]);
    try {
      const destination = url
        ? await this.network.authorize(url, 'GET', signal)
        : undefined;
      this.worker ??= this.factory({
        jobId: this.id,
        network: this.network,
        limits: BROWSER_LIMITS,
        actionPolicy: BROWSER_ACTION_POLICY,
        signal: this.signal,
      });
      const result = await abortable(
        this.worker.run({
          argv: [
            '--session',
            this.id,
            '--allowed-domains',
            this.network.domains.join(','),
            '--content-boundaries',
            '--max-output',
            String(BROWSER_LIMITS.outputChars),
            ...(destination && args[0] === 'open'
              ? ['open', destination.url]
              : args),
          ],
          destination,
          signal,
        }),
        signal,
      );
      if (
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) >
        BROWSER_LIMITS.transportBytes
      )
        throw new Error('Browser transport output limit reached.');
      if (result.exitCode !== 0) throw new Error('Browser command failed.');
      const text = result.stdout.slice(0, BROWSER_LIMITS.outputChars);
      this.output += text.length;
      if (this.output > BROWSER_LIMITS.totalOutputChars)
        throw new Error('Browser output limit reached.');
      return text;
    } finally {
      this.busy = false;
    }
  }

  async snapshot(url?: string) {
    if (url) {
      this.currentUrl = undefined;
      await this.command(['open', url], url);
    } else if (!this.currentUrl) throw new Error('Open a public URL first.');
    const current = await this.command(['get', 'url']);
    const target = await this.network.authorize(
      current.trim(),
      'GET',
      this.signal,
    );
    this.currentUrl = target.url;
    const text = await this.command(['snapshot', '-c']);
    return { url: target.url, text, untrusted: true as const };
  }

  async followLink(ref: string) {
    if (!/^@e[1-9]\d{0,5}$/.test(ref) || !this.currentUrl)
      throw new Error('A current link ref is required.');
    // Resolve the link and navigate; never click a button or submit a form.
    const href = await this.command(['get', 'attr', ref, 'href']);
    return this.snapshot(new URL(href.trim(), this.currentUrl).href);
  }

  async scroll(direction: 'up' | 'down', amount: number) {
    if (
      !this.currentUrl ||
      !['up', 'down'].includes(direction) ||
      !Number.isInteger(amount) ||
      amount < 1 ||
      amount > 2000
    )
      throw new Error('Invalid browser scroll.');
    await this.command(['scroll', direction, String(amount)]);
    return this.snapshot();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancel.abort();
    if (this.worker) {
      const signal = AbortSignal.timeout(BROWSER_LIMITS.cleanupMs);
      // A failed cleanup quarantines its slot rather than launching more children.
      await abortable(this.worker.dispose(signal), signal);
    }
    this.release();
  }
}
