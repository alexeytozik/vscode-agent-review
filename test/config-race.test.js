'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createConnection } = require('../hook-connection');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-config.')), home = path.join(root, 'home');
  await fs.mkdir(home); const config = path.join(home, 'hooks.json');
  const foreign = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'foreign-hook' }] }] } };
  await fs.writeFile(config, JSON.stringify(foreign));
  const connection = createConnection({ storage: path.join(root, 'profile'), root, home, extensionPath: path.resolve('.'), executable: process.execPath, enabled: () => true, receive: async () => {}, report: () => {} });
  await connection.ready; await connection.connect();
  t.after(async () => { await connection.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, config, connection, foreign };
}
for (const action of ['connect', 'disconnect']) for (const race of ['foreign edit', 'symlink']) test('R19 ' + action + ' stops when configuration changes to ' + race + ' before replacement', async t => {
  const f = await fixture(t), write = fs.writeFile, target = path.join(f.root, 'target.json');
  const changed = { ...f.foreign, description: 'new foreign setting' }, text = JSON.stringify(changed);
  await write(target, text); let hit = false;
  t.mock.method(fs, 'writeFile', async (...args) => {
    const result = await write(...args);
    if (!hit && typeof args[0] === 'string' && args[0].startsWith(f.config + '.') && args[0].endsWith('.tmp')) {
      hit = true;
      if (race === 'symlink') { await fs.unlink(f.config); await fs.symlink(target, f.config); }
      else await write(f.config, text);
    }
    return result;
  });
  await assert.rejects(f.connection[action](), /changed|symbolic|regular/);
  assert.ok(hit); assert.equal(await fs.readFile(f.config, 'utf8'), text);
  assert.equal(await fs.readFile(target, 'utf8'), text);
  assert.equal((await fs.lstat(f.config)).isSymbolicLink(), race === 'symlink');
  assert.ok((await fs.readdir(f.connection.store)).includes('setup.json'), 'A failed disconnect must remain retryable');
});
test('R19 disconnect rejects an existing symlink and leaves its target unchanged', async t => {
  const f = await fixture(t), target = path.join(f.root, 'target.json'), text = await fs.readFile(f.config, 'utf8');
  await fs.writeFile(target, text); await fs.unlink(f.config); await fs.symlink(target, f.config);
  await assert.rejects(f.connection.disconnect(), /symbolic|regular/);
  assert.equal(await fs.readFile(target, 'utf8'), text); assert.ok((await fs.lstat(f.config)).isSymbolicLink());
});
test('R19 Disconnect cannot be undone by an overlapping automatic startup', async t => {
  const f = await fixture(t), originalMkdir = fs.mkdir;
  f.connection.dispose();
  for (let i = 0; i < 100 && await fs.stat(path.join(f.connection.store, 'owner.lock')).then(() => true, () => false); i++) await new Promise(resolve => setTimeout(resolve, 5));
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), paused = new Promise(resolve => { release = resolve; });
  let intercepted = false;
  t.mock.method(fs, 'mkdir', async (...args) => {
    if (!intercepted && args[0] === path.join(f.connection.store, 'events')) { intercepted = true; entered(); await paused; }
    return originalMkdir(...args);
  });
  const connection = createConnection({ storage: path.dirname(f.connection.store), root: f.root, home: path.join(f.root, 'home'), extensionPath: path.resolve('.'), executable: process.execPath, enabled: () => true, receive: async () => {}, report: () => {} });
  t.after(() => connection.dispose()); await started;
  const disconnect = connection.disconnect(); await new Promise(resolve => setTimeout(resolve, 30)); release();
  await connection.ready; await disconnect;
  assert.equal(await connection.decision({ turn: 'thread/request', path: path.join(f.root, 'file') }, 'accept'), false);
  for (const name of ['setup.json', 'owner.lock', 'connection.json']) assert.equal(await fs.lstat(path.join(connection.store, name)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; }), false, name);
});
