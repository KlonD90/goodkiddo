// Explicit operator fixture: verify the real broker's watchdog, not a mock clock.
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

function connection() {
  const socket = net.createConnection('/run/goodkiddo-browser/worker.sock');
  let id = 0;
  let buffer = '';
  const pending = new Map<
    number,
    {
      resolve(value: { ok: boolean; output: string }): void;
      reject(error: Error): void;
    }
  >();
  const fail = () => {
    for (const item of pending.values())
      item.reject(new Error('Socket closed'));
    pending.clear();
  };
  socket.on('error', fail);
  socket.on('close', fail);
  socket.on('data', (bytes) => {
    buffer += bytes.toString('utf8');
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const value = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(value.id)?.resolve(value);
      pending.delete(value.id);
    }
  });
  return {
    socket,
    request(value: Record<string, unknown>) {
      const requestId = ++id;
      return new Promise<{ ok: boolean; output: string }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Fixture timeout')),
          20_000,
        );
        pending.set(requestId, {
          resolve: (reply) => {
            clearTimeout(timer);
            resolve(reply);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.write(JSON.stringify({ ...value, id: requestId }) + '\n');
      });
    },
  };
}
const first = connection();
let second: ReturnType<typeof connection> | undefined;
const began = Date.now();
const waitUntil = (elapsed: number) =>
  new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, elapsed - (Date.now() - began))),
  );
try {
  assert.equal(
    (await first.request({ type: 'start', jobId: `research-${randomUUID()}` }))
      .ok,
    true,
  );
  assert.equal(
    (
      await first.request({ type: 'command', command: { action: 'get_url' } })
    ).output.trim(),
    'about:blank',
  );
  console.log('PASS real browser started; waiting for 60-second expiry');
  await waitUntil(55_000);
  assert.equal(
    (await first.request({ type: 'command', command: { action: 'get_url' } }))
      .ok,
    true,
  );
  console.log('PASS real browser remains usable at 55 seconds');
  await waitUntil(64_000);
  assert.equal(
    (await first.request({ type: 'command', command: { action: 'get_url' } }))
      .ok,
    false,
  );
  second = connection();
  assert.equal(
    (await second.request({ type: 'start', jobId: `research-${randomUUID()}` }))
      .ok,
    true,
  );
  assert.equal(
    (
      await second.request({ type: 'command', command: { action: 'get_url' } })
    ).output.trim(),
    'about:blank',
  );
  console.log(
    'PASS expired job is closed and global capacity admits a fresh browser',
  );
  assert.equal((await second.request({ type: 'close' })).ok, true);
  assert.equal((await first.request({ type: 'close' })).ok, true);
  console.log('PASS both cleanup acknowledgments');
} finally {
  first.socket.destroy();
  second?.socket.destroy();
}
