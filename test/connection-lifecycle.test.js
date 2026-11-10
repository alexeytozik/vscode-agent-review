'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createPatch } = require('diff');
const { createConnection } = require('../hook-connection');
const { ReviewModel } = require('../review-model');
const { withCaptureLock } = require('../file-lock');

function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-connection-lifecycle.')));
  const workspace = path.join(root, 'workspace'), storage = path.join(root, 'profile'), home = path.join(root, 'home'), connections = [], errors = [];
  await fs.mkdir(workspace);
  t.after(async () => { await Promise.all(connections.map(connection => connection.dispose())); await fs.rm(root, { recursive: true, force: true }); });
  async function connection(receive, report = error => errors.push(error)) {
    const value = createConnection({ root: workspace, storage, home, extensionPath: path.resolve(__dirname, '..'), executable: process.execPath, enabled: () => true, receive, report });
    connections.push(value); await value.ready; return value;
  }
  const record = (id, name) => {
    const full = path.join(workspace, name);
    return { method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'session', turnId: 'request', itemId: id, changes: [{ path: full, kind: { type: 'update' }, diff: createPatch(full, 'before\n', 'after\n'), snapshot: { disk: 'after\n', text: 'after\n', mode: 0o644, canonical: full } }] };
  };
  async function event(connection, records) {
    const directory = path.join(connection.store, 'events'), file = path.join(directory, '001-event.json');
    await fs.mkdir(directory, { recursive: true }); await fs.writeFile(file, JSON.stringify({ version: 1, records })); return file;
  }
  return { root, workspace, home, connection, record, event, errors };
}

test('dispose waits for a blocked receive and preserves its partially delivered batch for deduplicated restart', { timeout: 5000 }, async t => {
  const f = await fixture(t), entered = gate(), release = gate(), model = new ReviewModel(), received = [];
  const connection = await f.connection(async record => { received.push(record.itemId); model.receive(record); entered.resolve(); await release.promise; });
  const file = await f.event(connection, [f.record('first', 'first.txt'), f.record('second', 'second.txt')]);
  const draining = connection.drain(); await entered.promise;
  const queued = connection.drain(); let closed = false;
  const disposal = connection.dispose().then(() => { closed = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(closed, false, 'A pending receive must finish before dispose resolves');
  } finally { release.resolve(); await Promise.all([draining, queued, disposal]); }
  assert.deepEqual(received, ['first'], 'No later record is delivered after closing starts');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).records.length, 2, 'The original envelope remains retryable');
  const restarted = await f.connection(async record => model.receive(record));
  await restarted.drain();
  assert.deepEqual(model.turns.get('session/request').seen, ['first', 'second']);
  assert.equal(model.entries().length, 2);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('queued drain callbacks do not begin delivery once disposal starts', async t => {
  const f = await fixture(t), received = [], connection = await f.connection(async record => received.push(record));
  const file = await f.event(connection, [f.record('first', 'first.txt')]);
  const first = connection.drain(), second = connection.drain(), disposal = connection.dispose();
  await Promise.all([first, second, disposal]);
  assert.deepEqual(received, []); assert.ok(await fs.stat(file));
});

test('drain after disposal neither acknowledges pending events nor recreates capture locks', async t => {
  const f = await fixture(t), received = [], connection = await f.connection(async record => received.push(record));
  const file = await f.event(connection, [f.record('first', 'first.txt')]);
  await connection.dispose(); await fs.rm(path.join(connection.store, 'capture-lock'), { recursive: true, force: true });
  let writes = 0; const mkdir = fs.mkdir;
  t.mock.method(fs, 'mkdir', async (...args) => { if (String(args[0]).startsWith(connection.store + path.sep)) writes++; return mkdir(...args); });
  await Promise.all([connection.drain(), connection.drain()]);
  assert.equal(writes, 0); assert.deepEqual(received, []); assert.ok(await fs.stat(file));
  await assert.rejects(fs.stat(path.join(connection.store, 'capture-lock')), { code: 'ENOENT' });
});

test('closing a drain queued on capture lock preserves the event and waits for lock cleanup', { timeout: 5000 }, async t => {
  const f = await fixture(t), received = [], connection = await f.connection(async record => received.push(record));
  const file = await f.event(connection, [f.record('first', 'first.txt')]);
  const entered = gate(), release = gate(), waiting = gate();
  const holder = withCaptureLock(connection.store, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const writeFile = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (...args) => { const result = await writeFile(...args); if (path.dirname(String(args[0])) === path.join(connection.store, 'capture-lock')) waiting.resolve(); return result; });
  const draining = connection.drain(); await waiting.promise;
  const disposal = connection.dispose();
  release.resolve(); await Promise.all([holder, draining, disposal]);
  assert.deepEqual(received, []); assert.ok(await fs.stat(file));
  assert.deepEqual(await fs.readdir(path.join(connection.store, 'capture-lock')), []);
});

test('a throwing report callback cannot skip owner and lease cleanup after drain rejects', async t => {
  const f = await fixture(t), connection = await f.connection(async () => {}, () => { throw new Error('observer failed'); });
  await connection.connect();
  const stat = fs.stat, health = path.join(connection.store, 'event-health.json');
  t.mock.method(fs, 'stat', async (...args) => { if (args[0] === health) throw Object.assign(new Error('temporary health read'), { code: 'EIO' }); return stat(...args); });
  await assert.rejects(connection.drain(), /observer failed/);
  await connection.dispose();
  for (const name of ['connection.json', 'owner.lock']) await assert.rejects(fs.lstat(path.join(connection.store, name)), { code: 'ENOENT' });
  const { select, keyFor } = require('../hook-dispatch');
  await assert.rejects(fs.lstat(path.join(f.home, 'review-hooks', 'leases', keyFor(f.workspace) + '.json')), { code: 'ENOENT' });
  assert.equal(await select(path.join(f.home, 'review-hooks'), f.workspace), undefined);
  await connection.drain();
});
