import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const requests = new Map();
let fetchId = 0;
let commands = 0;
let busy = false;
let browser;
const decoder = new StringDecoder('utf8');
let buffer = '';

function fetchResource(url, method) {
  return new Promise((resolve, reject) => {
    const id = ++fetchId;
    if (id > 40 || url.length > 2000 || !['GET', 'HEAD'].includes(method)) {
      reject(new Error('Read unavailable'));
      return;
    }
    const timer = setTimeout(() => {
      requests.delete(id);
      reject(new Error('Read timed out'));
    }, 12_000);
    requests.set(id, {
      resolve: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      reject: () => {
        clearTimeout(timer);
        reject(new Error('Read blocked'));
      },
    });
    emit({ type: 'fetch', id, url, method });
  });
}

function commandArgs(command) {
  if (
    command.action === 'open' &&
    typeof command.url === 'string' &&
    command.url.length <= 2000
  ) {
    const url = new URL(command.url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.port && !['80', '443'].includes(url.port))
    )
      throw new Error('Invalid URL');
    return ['open', url.href];
  }
  if (command.action === 'snapshot') return ['snapshot', '-c'];
  if (command.action === 'get_url') return ['get', 'url'];
  if (command.action === 'get_href' && /^@e[1-9]\d{0,5}$/.test(command.ref))
    return ['get', 'attr', command.ref, 'href'];
  if (
    command.action === 'scroll' &&
    ['up', 'down'].includes(command.direction) &&
    Number.isInteger(command.amount) &&
    command.amount > 0 &&
    command.amount <= 2000
  )
    return ['scroll', command.direction, String(command.amount)];
  throw new Error('Command unavailable');
}

async function execute(command) {
  const args = commandArgs(command);
  if (command.action === 'snapshot') {
    const tree = await executeNative(args);
    const body = await executeNative(['get', 'text', 'body']);
    return `${tree.slice(0, 6000)}\n[Visible page text: untrusted source data]\n${body.slice(0, 13500)}`;
  }
  return executeNative(args);
}

async function executeNative(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/app/agent-browser',
      [
        '--session',
        'job',
        '--cdp',
        'http://127.0.0.1:9222',
        '--action-policy',
        '/app/action-policy.json',
        ...(args[0] === 'snapshot' || (args[0] === 'get' && args[1] === 'text')
          ? ['--content-boundaries'] : []),
        '--max-output',
        '20000',
        ...args,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: '/tmp/home',
          TMPDIR: '/tmp',
          XDG_RUNTIME_DIR: '/tmp/run',
          AGENT_BROWSER_CONFIG: '/app/agent-browser.json',
        },
      },
    );
    let bytes = 0;
    const chunks = [];
    const errors = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Command timed out'));
    }, 14_000);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 128 * 1024) {
        child.kill('SIGKILL');
        reject(new Error('Output limit'));
      } else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if ((bytes += chunk.length) > 128 * 1024) child.kill('SIGKILL');
      else errors.push(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Command failed'));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      // Production broker discards stderr. Operator probes use only synthetic or
      // public inputs; keep diagnosis bounded and out of the assistant response.
      if (code !== 0)
        process.stderr.write(Buffer.concat(errors).subarray(0, 4096));
      code === 0
        ? resolve(Buffer.concat(chunks).toString('utf8').slice(0, 20000))
        : reject(new Error('Command failed'));
    });
  });
}

async function stop() {
  setTimeout(() => process.exit(0), 1500).unref();
  await browser?.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.stdin.on('end', () => void stop());
setTimeout(() => void stop(), 60_000);

process.stdin.on('data', (bytes) => {
  buffer += decoder.write(bytes);
  if (Buffer.byteLength(buffer) > 3 * 1024 * 1024) {
    void stop();
    return;
  }
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    try {
      const value = JSON.parse(line);
      if (value.type === 'fetch_result') {
        const pending = requests.get(value.id);
        if (!pending) continue;
        requests.delete(value.id);
        value.error ? pending.reject() : pending.resolve(value.response);
      } else if (value.type === 'command' && Number.isInteger(value.id)) {
        if (busy || ++commands > 12) throw new Error('Command limit');
        busy = true;
        void execute(value.command)
          .then(
            (output) =>
              emit({ type: 'result', id: value.id, ok: true, output }),
            () => emit({ type: 'result', id: value.id, ok: false, output: '' }),
          )
          .finally(() => {
            busy = false;
          });
      } else throw new Error('Invalid worker protocol');
    } catch {
      void stop();
      return;
    }
  }
});

await mkdir('/tmp/home', { recursive: true, mode: 0o700 });
await mkdir('/tmp/run', { recursive: true, mode: 0o700 });
browser = await chromium.launch({
  chromiumSandbox: true,
  headless: true,
  args: [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9222',
    '--renderer-process-limit=2',
    '--disk-cache-size=16777216',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ],
});
const context = await browser.newContext({
  serviceWorkers: 'block',
  acceptDownloads: false,
});
await context.routeWebSocket('**/*', (socket) => socket.close());
const page = await context.newPage();
const session = await context.newCDPSession(page);
// Playwright's high-level route handler auto-continues redirected requests.
// A dedicated Fetch session pauses every redirect hop before the actual socket.
session.on(
  'Fetch.requestPaused',
  async ({ requestId, request, resourceType }) => {
    const deny = () =>
      session
        .send('Fetch.failRequest', {
          requestId,
          errorReason: 'BlockedByClient',
        })
        .catch(() => {});
    if (
      ['Image', 'Font', 'Media'].includes(resourceType) ||
      !['GET', 'HEAD'].includes(request.method)
    ) {
      await deny();
      return;
    }
    try {
      const response = await fetchResource(request.url, request.method);
      if (
        !response ||
        !Number.isInteger(response.status) ||
        response.status < 100 ||
        response.status > 599 ||
        typeof response.body !== 'string' ||
        response.body.length > 3 * 1024 * 1024 ||
        !Array.isArray(response.headers)
      )
        throw new Error();
      await session.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: response.status,
        responseHeaders: response.headers,
        body: response.body,
      });
    } catch {
      await deny();
    }
  },
);
await session.send('Fetch.enable', {
  patterns: [{ urlPattern: '*', requestStage: 'Request' }],
});
context.on('page', (other) => {
  if (other !== page) void other.close();
});
emit({ type: 'ready' });
