// Explicit operator verification only; never imported by the bot or auto-run.
import assert from 'node:assert/strict';
import { socketBrowserFactory } from '../src/browser-worker/client.js';
import { BrowserNetworkPolicy } from '../src/capabilities/browser/network-policy.js';
import {
  BrowserSlots,
  ReadOnlyBrowserJob,
} from '../src/capabilities/browser/job.js';

const factory = socketBrowserFactory('/run/goodkiddo-browser/worker.sock');
const slots = new BrowserSlots(1);
const job = new ReadOnlyBrowserJob(
  factory,
  new BrowserNetworkPolicy([], undefined, { publicBrowsing: true }),
  AbortSignal.timeout(60_000),
  slots,
  { chatId: 'synthetic-host-verification', taskId: 'synthetic-public-page' },
);
try {
  const snapshot = await job.snapshot('https://example.com/');
  assert.match(snapshot.text, /documentation examples/);
  console.log('PASS public Chromium returned rendered example.com text');
  const link = /link[^\n]*\[ref=(e\d+)\]/.exec(snapshot.text);
  assert.ok(link, 'Expected a public link reference');
  const next = await job.followLink(`@${link[1]}`);
  assert.match(next.url, /^https:\/\/(www\.)?iana\.org\//);
  assert.ok(next.text.length > 20);
  console.log('PASS read-only href navigation to public IANA page');
  await assert.rejects(job.snapshot('http://127.0.0.1/'));
  console.log('PASS private IP blocked before navigation');
} finally {
  await job.close();
  assert.equal(slots.count(), 0);
  console.log('PASS cleanup acknowledged and frontend capacity released');
}
