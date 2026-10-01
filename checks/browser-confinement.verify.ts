// Authored operator-only fixture, never available as an assistant command.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { containerArgs } from '../src/browser-worker/container.js';

const image = process.argv[2];
const args = containerArgs(
  `goodkiddo-browser-${randomUUID()}`,
  image,
  '/opt/goodkiddo-browser/seccomp.json',
);
args.splice(args.length - 1, 0, '--entrypoint=node');
const fixture = `
const assert=require('node:assert/strict'); const fs=require('node:fs'); const net=require('node:net');
(async()=>{
  assert.equal(process.getuid(),1000);
  assert.equal(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),'1073741824');
  assert.equal(fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),'128');
  const [quota,period]=fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim().split(' ').map(Number);
  assert.equal(quota/period,1);
  assert.match(fs.readFileSync('/proc/self/status','utf8'),/NoNewPrivs:\\s+1/);
  assert.match(fs.readFileSync('/proc/self/status','utf8'),/CapEff:\\s+0000000000000000/);
  for(const path of ['/opt/goodkiddo','/opt/goodkiddo-browser','/var/lib/goodkiddo','/etc/goodkiddo']) assert.equal(fs.existsSync(path),false,path);
  assert.throws(()=>fs.writeFileSync('/app/forbidden','synthetic'));
  fs.writeFileSync('/tmp/synthetic-check','test'); fs.unlinkSync('/tmp/synthetic-check');
  await new Promise((resolve,reject)=>{const socket=net.connect({host:'1.1.1.1',port:443});socket.once('error',e=>{socket.destroy();e.code==='ENETUNREACH'?resolve():reject(e)});socket.once('connect',()=>{socket.destroy();reject(new Error('Direct egress allowed'))});setTimeout(()=>{socket.destroy();reject(new Error('Egress check stalled'))},1000).unref()});
  console.log('PASS UID/cgroup CPU RAM PID/noNewPrivileges/capabilities/read-only/no-host-data/kernel-network-none');
  const {chromium}=require('/app/node_modules/playwright'); const browser=await chromium.launch({chromiumSandbox:true,headless:true});
  await browser.close(); console.log('PASS Chromium launches with native sandbox enabled');
})().catch(e=>{console.error(e);process.exitCode=1});
`;
args.push('-e', fixture);
const child = spawn('/usr/bin/podman', args, {
  // The fixture does not consume stdin. Do not let Podman read an operator's
  // remaining SSH heredoc commands into the container's otherwise unused stdin.
  stdio: ['ignore', 'inherit', 'inherit'],
  cwd: '/var/lib/goodkiddo-browser',
  env: {
    PATH: '/usr/bin:/bin',
    HOME: '/var/lib/goodkiddo-browser',
    XDG_RUNTIME_DIR: '/run/goodkiddo-browser-owner',
  },
});
child.once('exit', (code) => {
  process.exitCode = code || 0;
});
