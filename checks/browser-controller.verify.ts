import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { BrowserContainer } from '../src/browser-worker/container.js';
import { BrowserEgress } from '../src/browser-worker/egress.js';

// Public-only operator fixture; default production broker never logs stderr.
const job = new BrowserContainer(
  `research-${randomUUID()}`,
  process.argv[2],
  undefined,
  new BrowserEgress(),
  undefined,
  (text) => process.stderr.write(text),
);
try {
  await job.run({ action: 'open', url: 'https://example.com/' });
  const snapshot = await job.run({ action: 'snapshot' });
  assert.match(snapshot, /documentation examples/);
  assert.equal((await job.run({ action: 'get_url' })).trim(), 'https://example.com/');
  console.log('PASS guarded Chromium/agent-browser public rendering');
} finally {
  await job.close();
}
