import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { BrowserEgress } from './egress.js';
import type { BrowserCommand } from './protocol.js';

export const CONTAINER_LIMITS = Object.freeze({
  cpu: '1',
  memory: '1g',
  pids: '128',
  wallMs: 60_000,
});
const ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/var/lib/goodkiddo-browser',
  XDG_RUNTIME_DIR: '/run/goodkiddo-browser-owner',
};
export function containerArgs(
  name: string,
  image: string,
  seccomp: string,
): string[] {
  if (
    !/^goodkiddo-browser-[0-9a-f-]{36}$/.test(name) ||
    !/^localhost\/goodkiddo-browser:[a-f0-9]{12}$/.test(image) ||
    seccomp !== '/opt/goodkiddo-browser/seccomp.json'
  )
    throw new Error('Invalid trusted container configuration.');
  return [
    '--cgroup-manager=cgroupfs',
    'run',
    '--rm',
    '--pull=never',
    '--name',
    name,
    '--cgroup-parent=/system.slice/goodkiddo-browser.service',
    '--timeout=60',
    '--network=none',
    '--read-only',
    '--user=1000:1000',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--security-opt=seccomp=${seccomp}`,
    '--cpus=1',
    '--memory=1g',
    '--memory-swap=1g',
    '--pids-limit=128',
    '--ipc=private',
    '--shm-size=64m',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777',
    '--env=HOME=/tmp/home',
    '--env=TMPDIR=/tmp',
    '--env=XDG_RUNTIME_DIR=/tmp/run',
    '--log-driver=none',
    '-i',
    image,
  ];
}

type Pending = { resolve(value: string): void; reject(error: Error): void };
export interface BrokerJob {
  run(command: BrowserCommand): Promise<string>;
  close(): Promise<void>;
}
export class BrowserContainer implements BrokerJob {
  readonly name: string;
  private readonly child;
  private readonly egress;
  private readonly cancel = new AbortController();
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new StringDecoder('utf8');
  private nextId = 0;
  private buffer = '';
  private output = 0;
  private busy = false;
  private closed = false;
  private exited = false;
  private readonly timeout;
  private readonly ready: Promise<void>;
  private readonly exit: Promise<void>;

  constructor(
    jobId: string,
    image: string,
    private readonly podman = '/usr/bin/podman',
    egress = new BrowserEgress(),
    private readonly onClosed: () => void = () => {},
    diagnostic: (text: string) => void = () => {},
  ) {
    this.name = `goodkiddo-browser-${jobId.slice('research-'.length)}`;
    this.egress = egress;
    this.child = spawn(
      podman,
      containerArgs(this.name, image, '/opt/goodkiddo-browser/seccomp.json'),
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: ENV.HOME,
        env: ENV,
      },
    );
    this.ready = new Promise((resolve, reject) =>
      this.pending.set(0, { resolve: () => resolve(), reject }),
    );
    // Keep the ready rejection observed even if a client vanishes before first run.
    this.ready.catch(() => {});
    this.exit = new Promise((resolve) =>
      this.child.once('close', () => {
        this.exited = true;
        resolve();
      }),
    );
    this.child.stdout.on('data', (bytes: Buffer) => this.read(bytes));
    let stderr = 0;
    this.child.stderr.on('data', (bytes: Buffer) => {
      if ((stderr += bytes.length) > 65536) this.stop();
      else diagnostic(bytes.toString('utf8'));
    });
    this.child.stdin.on('error', () => this.stop());
    this.child.on('error', () => {
      this.fail(new Error('Browser container could not start.'));
      this.stop();
    });
    this.child.on('exit', () => {
      this.fail(new Error('Browser container exited.'));
      this.stop();
    });
    this.timeout = setTimeout(() => this.stop(), CONTAINER_LIMITS.wallMs);
  }
  private stop() {
    void this.close().catch(() => {});
  }

  private fail(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  private send(value: unknown) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private read(bytes: Buffer) {
    if (this.closed) return;
    this.buffer += this.decoder.write(bytes);
    if (Buffer.byteLength(this.buffer) > 128 * 1024) {
      this.stop();
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (message.type === 'fetch') {
          if (
            typeof message.url !== 'string' ||
            message.url.length > 2000 ||
            !Number.isInteger(message.id) ||
            message.id < 1 ||
            message.id > 40 ||
            typeof message.method !== 'string'
          )
            throw new Error();
          void this.egress
            .fetch(message.url, message.method, this.cancel.signal)
            .then(
              (response) =>
                this.send({ type: 'fetch_result', id: message.id, response }),
              () =>
                this.send({
                  type: 'fetch_result',
                  id: message.id,
                  error: true,
                }),
            );
        } else if (message.type === 'ready') {
          this.pending.get(0)?.resolve('');
          this.pending.delete(0);
        } else if (message.type === 'result') {
          const pending = this.pending.get(message.id);
          if (!pending || typeof message.output !== 'string') throw new Error();
          this.output += message.output.length;
          if (message.output.length > 20_000 || this.output > 60_000)
            throw new Error();
          if (message.ok) pending.resolve(message.output);
          else pending.reject(new Error('Browser read command failed.'));
          this.pending.delete(message.id);
        } else throw new Error();
      } catch {
        this.stop();
        return;
      }
    }
  }

  async run(command: BrowserCommand): Promise<string> {
    if (this.closed || this.busy)
      throw new Error('Browser job is unavailable.');
    this.busy = true;
    const timer = setTimeout(() => {
      this.fail(new Error('Browser command timed out.'));
      this.stop();
    }, 15_000);
    try {
      await this.ready;
      if (this.closed) throw new Error('Browser job stopped.');
      const id = ++this.nextId;
      return await new Promise<string>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.send({ type: 'command', id, command });
      });
    } finally {
      clearTimeout(timer);
      this.busy = false;
    }
  }

  private closing?: Promise<void>;
  close(): Promise<void> {
    this.closing ??= this.remove();
    return this.closing;
  }
  private async remove(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timeout);
    this.cancel.abort();
    this.fail(new Error('Browser job stopped.'));
    this.child.stdin.end();
    // Stop the launcher before rm so a slow startup cannot create a late orphan.
    if (!this.exited) this.child.kill('SIGTERM');
    const kill = setTimeout(() => {
      if (!this.exited) this.child.kill('SIGKILL');
    }, 500);
    await this.exit;
    clearTimeout(kill);
    await new Promise<void>((resolve, reject) => {
      const cleanup = spawn(
        this.podman,
        ['--cgroup-manager=cgroupfs', 'rm', '--force', '--ignore', this.name],
        {
          stdio: 'ignore',
          cwd: ENV.HOME,
          env: ENV,
        },
      );
      const timer = setTimeout(() => {
        cleanup.kill('SIGKILL');
        reject(new Error('Browser cleanup was not confirmed.'));
      }, 3500);
      cleanup.on('error', () => {
        clearTimeout(timer);
        reject(new Error('Browser cleanup failed.'));
      });
      cleanup.on('exit', (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error('Browser cleanup failed.'));
      });
    });
    this.onClosed();
  }
}
