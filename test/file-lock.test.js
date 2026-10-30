'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto'), { spawn } = require('node:child_process');
const { withDirectoryLock } = require('../file-lock');
async function fixture(t) { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-lock.'))); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
test('ticket lock serializes eight processes without evicting a live slow writer', async t => {
  const root = await fixture(t), lock = path.join(root, 'lock'), counter = path.join(root, 'count'); await fs.writeFile(counter, '0');
  const code = "const fs=require('node:fs/promises'),path=require('node:path');require(process.argv[1]).withDirectoryLock(process.argv[2],async()=>{const guard=path.join(process.argv[2],'critical');await fs.writeFile(guard,'active',{flag:'wx'});const n=Number(await fs.readFile(process.argv[3],'utf8'));await new Promise(r=>setTimeout(r,30));await fs.writeFile(process.argv[3],String(n+1));await fs.unlink(guard);}).catch(e=>{process.stderr.write(e.stack);process.exitCode=1});";
  await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, require.resolve('../file-lock'), lock, counter], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] }); let error = '';
    child.stderr.on('data', chunk => { error += chunk; }); child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(error)));
  })));
  assert.equal(await fs.readFile(counter, 'utf8'), '8'); assert.deepEqual(await fs.readdir(lock), []);
});
test('dead unique tickets are reaped, while an unreadable live choosing ticket times out closed', async t => {
  const root = await fixture(t), lock = path.join(root, 'lock'); await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, '999999-' + randomUUID() + '.json'), '{'); let calls = 0;
  await withDirectoryLock(lock, async () => { calls++; }); assert.equal(calls, 1);
  const live = path.join(lock, process.pid + '-' + randomUUID() + '.json'); await fs.writeFile(live, '{');
  await assert.rejects(withDirectoryLock(lock, async () => { calls++; }, { timeout: 30 }), /busy/); assert.equal(calls, 1); assert.equal(await fs.readFile(live, 'utf8'), '{');
});
test('ticket cleanup runs after callback failure and refuses a symlink directory', async t => {
  const root = await fixture(t), lock = path.join(root, 'lock');
  await assert.rejects(withDirectoryLock(lock, async () => { throw new Error('callback failed'); }), /callback failed/); assert.deepEqual(await fs.readdir(lock), []);
  const alias = path.join(root, 'alias'); await fs.symlink(lock, alias); await assert.rejects(withDirectoryLock(alias, async () => assert.fail()), /unsafe/);
});
