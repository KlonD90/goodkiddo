// Real Chromium, entirely synthetic source responses; no private host requests.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BrowserContainer } from '../src/browser-worker/container.js';
import { BrowserEgress } from '../src/browser-worker/egress.js';
import type { PageDependencies } from '../src/providers/assistant-page.js';

const script = `<h1 id="result">Pending</h1><script>
(async()=>{
 const results=[];
 const blocked=async(url,options,name)=>{try{await fetch(url,options);results.push('FAIL_'+name)}catch{results.push('PASS_'+name)}};
 await blocked('https://127.0.0.1/private',{},'PRIVATE');
 await blocked('https://synthetic.example/post',{method:'POST',body:'synthetic'},'WRITE');
 await blocked('https://redirect.example/private',{},'REDIRECT');
 await fetch('https://rebind.example/one');
 await blocked('https://rebind.example/two',{},'REBIND');
 await new Promise(resolve=>{const ws=new WebSocket('ws://127.0.0.1:9222/forbidden');let opened=false;ws.onopen=()=>{opened=true;results.push('FAIL_SOCKET');ws.close();resolve()};const done=()=>{if(!opened)results.push('PASS_SOCKET');resolve()};ws.onerror=done;ws.onclose=done});
 localStorage.setItem('synthetic-job-state','first');
 document.getElementById('result').textContent=results.join(' ');
})().catch(()=>document.getElementById('result').textContent='FAIL_SCRIPT');
</script>`;
const fetched: string[] = [];
const attempted: string[] = [];
let rebind = 0;
const dependencies: PageDependencies = {
  resolve: async (host) => [
    {
      address:
        host === 'rebind.example' && ++rebind > 1 ? '10.0.0.1' : '8.8.8.8',
      family: 4,
    },
  ],
  request: async (url) => {
    fetched.push(url.href);
    if (url.hostname === 'redirect.example')
      return {
        status: 302,
        headers: {
          location:
            url.pathname === '/public'
              ? 'https://public.example/final'
              : 'https://127.0.0.1/redirect-target',
        },
        bytes: Buffer.alloc(0),
      };
    return {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'access-control-allow-origin': '*',
      },
      bytes: Buffer.from(
        url.hostname === 'synthetic.example'
          ? script
          : 'Synthetic public response',
      ),
    };
  },
};
class ObservedEgress extends BrowserEgress {
  override fetch(url: string, method: string, signal: AbortSignal) {
    attempted.push(url);
    return super.fetch(url, method, signal);
  }
}
const job = new BrowserContainer(
  `research-${randomUUID()}`,
  process.argv[2],
  undefined,
  new ObservedEgress(dependencies),
  undefined,
  (text) => process.stderr.write(text),
);
try {
  await job.run({ action: 'open', url: 'https://synthetic.example/test' });
  let snapshot = '';
  for (let n = 0; n < 7; n++) {
    snapshot = await job.run({ action: 'snapshot' });
    if (snapshot.includes('PASS_REBIND') && snapshot.includes('PASS_SOCKET'))
      break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  for (const name of ['PRIVATE', 'WRITE', 'REDIRECT', 'REBIND', 'SOCKET'])
    assert.match(snapshot, new RegExp(`PASS_${name}`));
  assert.doesNotMatch(snapshot, /FAIL_/);
  // XHR may reject a redirect before following it because of browser CORS/PNA
  // rules. Top-level navigation exercises interception of the actual next hop.
  await job.run({ action: 'open', url: 'https://redirect.example/public' });
  assert.equal(
    (await job.run({ action: 'get_url' })).trim(),
    'https://public.example/final',
  );
  assert.match(
    await job.run({ action: 'snapshot' }),
    /Synthetic public response/,
  );
  console.log('PASS top-level public redirect is rendered');
  await assert.rejects(
    job.run({ action: 'open', url: 'https://redirect.example/private' }),
  );
  assert.ok(
    attempted.includes('https://127.0.0.1/redirect-target'),
    'Redirect hop was paused for validation',
  );
  assert.ok(!fetched.some((url) => new URL(url).hostname === '127.0.0.1'));
  assert.ok(!fetched.includes('https://rebind.example/two'));
  assert.ok(!fetched.includes('https://synthetic.example/post'));
  console.log(
    'PASS real JS rendering/private-IP/redirect-hop/DNS-rebind/POST/WebSocket denial',
  );
} finally {
  await job.close();
}

const fresh = new BrowserContainer(
  `research-${randomUUID()}`,
  process.argv[2],
  undefined,
  new BrowserEgress({
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      bytes: Buffer.from(
        `<h1 id="result">Pending</h1><script>document.getElementById('result').textContent=localStorage.getItem('synthetic-job-state')===null?'PASS_ISOLATION':'FAIL_ISOLATION'</script>`,
      ),
    }),
  }),
);
try {
  await fresh.run({ action: 'open', url: 'https://synthetic.example/test' });
  assert.match(await fresh.run({ action: 'snapshot' }), /PASS_ISOLATION/);
  console.log('PASS fresh job has no previous browser storage');
} finally {
  await fresh.close();
  console.log('PASS both real containers cleaned');
}
