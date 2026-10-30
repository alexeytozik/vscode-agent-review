'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ReviewModel } = require('../review-model');
const { createConnection } = require('../hook-connection');
const { handle, atomic, hash, deliver, run } = require('../hook-runner');
const { Readable, Writable } = require('node:stream');

function model() {
  return new ReviewModel({ version: 2, turns: [{ key: 'session/turn', id: 'turn', threadId: 'session', created: 1, warnings: [], seen: [], files: [
    { path: '/tmp/complex.txt', baseline: 'old\n'.repeat(6000), expected: 'new\n'.repeat(6000), mode: 0o644 },
    { path: '/tmp/safe.txt', baseline: '\uFEFFстарое\r\nlast', expected: '\uFEFFновое\r\nlast', mode: 0o755 }
  ] }] });
}

test('R01 complex diff isolates one file and preserves safe decisions across restore', () => {
  let m = model();
  for (let restart = 0; restart < 2; restart++) {
    const entries = m.entries(), complex = entries[0], safe = entries[1];
    assert.match(complex.file.error, /diff is too large/);
    assert.equal(complex.hunks.length, 0);
    assert.throws(() => m.decide(complex.turn.key, complex.file.path, complex.revision, 'any', 'reject'), /diff is too large/);
    assert.equal(m.decide(safe.turn.key, safe.file.path, safe.revision, safe.hunks[0].id, 'reject').current, safe.file.baseline);
    assert.equal(m.decide(safe.turn.key, safe.file.path, safe.revision, safe.hunks[0].id, 'accept').baseline, safe.file.expected);
    m.refresh(complex.turn.key, complex.file.path, complex.file.expected);
    assert.match(m.entries()[0].file.error, /diff is too large/);
    m = new ReviewModel(JSON.parse(JSON.stringify(m.save())));
  }
});

test('R01 failed diff is computed once, including refresh and restore', () => {
  const core = require('../core'), localRequire = require('node:module').createRequire(require.resolve('../review-model'));
  const module = { exports: {} }; let calls = 0;
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../review-model'), 'utf8'), {
    module, Buffer, require: id => id === './core' ? { ...core, changes: (before, after) => {
      if (before === 'old\n'.repeat(6000)) calls++;
      return core.changes(before, after);
    } } : localRequire(id)
  });
  let m = new module.exports.ReviewModel(model().save());
  for (let i = 0; i < 5; i++) {
    m.entries(); m.refresh('session/turn', '/tmp/complex.txt', 'new\n'.repeat(6000));
    m = new module.exports.ReviewModel(JSON.parse(JSON.stringify(m.save())));
  }
  assert.equal(calls, 1);
  const file = m.turns.get('session/turn').files.get('/tmp/complex.txt');
  file.baseline = 'old\n'; file.expected = 'new\n';
  assert.equal(m.entries()[0].hunks.length, 1, 'Different inputs do not inherit a failed diff');
  assert.equal(file.error, undefined);
});

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-reliability.')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), storage = path.join(root, 'profile');
  await fs.mkdir(workspace);
  const store = path.join(storage, 'lifecycle');
  await atomic(path.join(store, 'connection.json'), { root: workspace, pid: process.pid, enabled: true, updated: Date.now() });
  return { root, workspace, storage, store };
}
const record = (turnId = 'turn') => ({ method: 'turn/started', threadId: 'session', turnId });
const prompt = f => ({ hook_event_name: 'UserPromptSubmit', session_id: 'session', turn_id: 'next', cwd: f.workspace });
async function connectionFor(t, f, receive = async () => {}) {
  const errors = [], connection = createConnection({ storage: f.storage, home: path.join(f.root, 'home'), extensionPath: path.resolve('.'), executable: process.execPath, root: f.workspace, enabled: () => true, receive, report: e => errors.push(e) });
  t.after(() => connection.dispose()); await connection.ready;
  return { connection, errors };
}

test('R02 corrupt event does not block the next valid event or repeat warnings', async t => {
  const f = await fixture(t), received = [], errors = [];
  const connection = createConnection({ storage: f.storage, home: path.join(f.root, 'home'), extensionPath: path.resolve('.'), executable: process.execPath, root: f.workspace, enabled: () => true, receive: async e => received.push(e), report: e => errors.push(e) });
  t.after(() => connection.dispose()); await connection.ready;
  await atomic(path.join(f.store, 'events', '002-valid.json'), { version: 1, records: [record()] });
  await fs.writeFile(path.join(f.store, 'events', '001-broken.json'), '{');
  await connection.drain(); await connection.drain();
  assert.deepEqual(received, [record()]);
  assert.equal(errors.length, 1);
  assert.equal(connection.status().incomplete, true);
});
for (const [name, alter] of [
  ['mode', change => change.snapshot.mode = '644'], ['canonical', change => change.snapshot.canonical = '/outside/file'],
  ['nul path', change => change.path += '\0'], ['nul canonical', change => change.snapshot.canonical = change.path + '\0'],
  ['mode range', change => change.snapshot.mode = 0o1000], ['error', change => change.snapshot.error = 'x'.repeat(4097)],
  ['utf8', change => change.snapshot.disk = change.snapshot.text = '\ud800'], ['movePath', change => change.kind.movePath = '/outside/file']
]) test('R02 invalid live ' + name + ' cannot poison strict saved state or block a valid neighbour', async t => {
  const f = await fixture(t), model = new ReviewModel(), received = [];
  const { createStateStore } = require('../review-state'), store = createStateStore(path.join(f.storage, 'request-review.json'));
  const { connection } = await connectionFor(t, f, async event => { received.push(event.turnId); model.receive(event); await store.save(model.save()); });
  const change = { path: path.join(f.workspace, 'empty.txt'), kind: { type: 'add' }, diff: '', snapshot: { disk: '', text: '', mode: 0o644 } };
  alter(change);
  await atomic(path.join(f.store, 'events', '001-invalid.json'), { version: 1, records: [{ method: 'item/completed', type: 'fileChange', threadId: 'thread', turnId: 'invalid', itemId: 'item', status: 'completed', changes: [change] }] });
  await atomic(path.join(f.store, 'events', '002-valid.json'), { version: 1, records: [record('valid')] });
  await connection.drain(); await connection.drain();
  assert.deepEqual(received, ['valid']); assert.equal(model.turns.has('thread/invalid'), false);
  assert.deepEqual(await fs.readdir(path.join(f.store, 'events')), []);
  assert.equal(new ReviewModel((await store.load()).state).turns.size, 1);
});

test('R03 valid Undo survives a following corrupt feedback record', async t => {
  const f = await fixture(t), directory = path.join(f.store, 'feedback', hash('session'));
  await atomic(path.join(directory, '001-valid.json'), { action: 'reject', path: path.join(f.workspace, 'file.txt') });
  await fs.writeFile(path.join(directory, '002-broken.json'), '{');
  const result = await handle(f.store, prompt(f));
  assert.match(result.hookSpecificOutput.additionalContext, /0 kept, 1 undone/);
  assert.match(result.hookSpecificOutput.additionalContext, /file.txt/);
  assert.ok(await fs.stat(path.join(directory, '001-valid.json')), 'preparing a response must not consume it');
  await deliver(result, async text => assert.match(text, /0 kept, 1 undone/));
  assert.deepEqual(await handle(f.store, prompt(f)), {});
});

for (const [name, invalid] of [
  ['null envelope', null], ['wrong version', { version: 2, records: [record()] }],
  ['null event', { version: 1, records: [null] }],
  ['missing ID', { version: 1, records: [{ method: 'turn/started' }] }],
  ['changes type', { version: 1, records: [{ ...record(), changes: {} }] }],
  ['invalid second event', { version: 1, records: [record('not-delivered'), {}] }],
  ['invalid snapshot', { version: 1, records: [{ ...record(), method: 'item/completed', type: 'fileChange', itemId: 'item', changes: [{ path: '/tmp/file.txt', kind: { type: 'update' }, snapshot: [] }] }] }]
]) test('R02 isolates malformed schema: ' + name, async t => {
  const f = await fixture(t), received = [], { connection, errors } = await connectionFor(t, f, async e => received.push(e));
  const payload = structuredClone(invalid);
  if (name === 'invalid snapshot') payload.records[0].changes[0].path = path.join(f.workspace, 'file.txt');
  await atomic(path.join(f.store, 'events', '001-invalid.json'), payload);
  await atomic(path.join(f.store, 'events', '002-valid.json'), { version: 1, records: [record()] });
  await connection.drain(); await connection.drain();
  assert.deepEqual(received, [record()]); assert.equal(errors.length, 1);
  assert.deepEqual(await fs.readdir(path.join(f.store, 'events')), []);
});

test('R02 oversize and symlink records are isolated without reading or changing their targets', async t => {
  const f = await fixture(t), received = [], { connection } = await connectionFor(t, f, async e => received.push(e));
  const dir = path.join(f.store, 'events'), target = path.join(f.root, 'private.txt');
  await atomic(path.join(dir, '003-valid.json'), { version: 1, records: [record()] });
  await fs.writeFile(target, 'private marker', { mode: 0o640 });
  await fs.symlink(target, path.join(dir, '002-link.json'));
  await fs.writeFile(path.join(dir, '001-large.json'), ''); await fs.truncate(path.join(dir, '001-large.json'), 26 * 1024 * 1024);
  await connection.drain();
  assert.deepEqual(received, [record()]); assert.equal(await fs.readFile(target, 'utf8'), 'private marker');
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
  const quarantine = path.join(f.store, 'event-quarantine');
  assert.equal((await fs.stat(quarantine)).mode & 0o777, 0o700);
  const names = await fs.readdir(quarantine);
  for (const name of names.filter(n => n.endsWith('.json'))) {
    assert.equal((await fs.stat(path.join(quarantine, name))).mode & 0o777, 0o600);
    assert.doesNotMatch(await fs.readFile(path.join(quarantine, name), 'utf8'), /private marker/);
  }
  const size = (await Promise.all(names.map(n => fs.lstat(path.join(quarantine, n))))).reduce((n, s) => n + s.size, 0);
  assert.ok(size <= 25 * 1024 * 1024);
});

test('R02 a disappeared file does not block the following event', async t => {
  const f = await fixture(t), received = [], { connection, errors } = await connectionFor(t, f, async e => received.push(e));
  const vanished = path.join(f.store, 'events', '001-gone.json');
  await atomic(vanished, { version: 1, records: [record('gone')] });
  await atomic(path.join(f.store, 'events', '002-valid.json'), { version: 1, records: [record()] });
  const lstat = fs.lstat;
  t.mock.method(fs, 'lstat', async (...args) => {
    if (args[0] === vanished) { await fs.unlink(vanished); throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }
    return lstat(...args);
  });
  await connection.drain(); assert.deepEqual(received, [record()]); assert.deepEqual(errors, []);
});

for (const kind of ['read', 'receive']) test('R02 temporary ' + kind + ' failure is retried in order, never quarantined', async t => {
  const f = await fixture(t), received = []; let failing = true;
  const { connection, errors } = await connectionFor(t, f, async e => {
    if (kind === 'receive' && failing) throw Object.assign(new Error('try again'), { code: 'EIO' });
    received.push(e);
  });
  const first = path.join(f.store, 'events', '001-first.json');
  await atomic(first, { version: 1, records: [record('first')] });
  await atomic(path.join(f.store, 'events', '002-next.json'), { version: 1, records: [record('next')] });
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    if (kind === 'read' && failing && args[0] === first) throw Object.assign(new Error('try again'), { code: 'EIO' });
    return open(...args);
  });
  await connection.drain(); await connection.drain();
  assert.deepEqual(received, []); assert.equal(errors.length, 1);
  assert.equal((await fs.readdir(path.dirname(first))).length, 2);
  await assert.rejects(fs.stat(path.join(f.store, 'event-quarantine')), { code: 'ENOENT' });
  failing = false; await connection.drain(); await connection.drain();
  assert.deepEqual(received, [record('first'), record('next')]);
});

test('R02 restart retains incomplete coverage and bounded quarantine without duplicate delivery', async t => {
  const f = await fixture(t), received = [], { connection, errors } = await connectionFor(t, f, async e => received.push(e));
  for (let i = 0; i < 36; i++) await atomic(path.join(f.store, 'events', String(i).padStart(3, '0') + '-bad.json'), {});
  await atomic(path.join(f.store, 'events', '099-valid.json'), { version: 1, records: [record()] });
  await connection.drain(); await connection.drain();
  assert.equal(errors.length, 36); assert.deepEqual(received, [record()]);
  const dir = path.join(f.store, 'event-quarantine');
  assert.equal((await fs.readdir(dir)).filter(n => n.endsWith('.json')).length, 32);
  assert.equal((await fs.readdir(dir)).filter(n => n.endsWith('.record')).length, 32);
  connection.dispose();
  const restarted = await connectionFor(t, f, async e => received.push(e));
  await restarted.connection.drain();
  assert.equal(restarted.connection.status().incomplete, true); assert.deepEqual(restarted.errors, []);
  assert.deepEqual(received, [record()]);
});

test('R02 quarantine size limit evicts payloads and keeps private reasons', async t => {
  const f = await fixture(t), { connection } = await connectionFor(t, f);
  const dir = path.join(f.store, 'events'); await fs.mkdir(dir);
  for (let i = 0; i < 2; i++) await fs.writeFile(path.join(dir, '00' + i + '-large.json'), 'x'.repeat(14 * 1024 * 1024));
  await connection.drain();
  const quarantine = path.join(f.store, 'event-quarantine'), names = await fs.readdir(quarantine);
  assert.equal(names.filter(n => n.endsWith('.json')).length, 2);
  assert.equal(names.filter(n => n.endsWith('.record')).length, 1);
  for (const name of names) assert.equal((await fs.stat(path.join(quarantine, name))).mode & 0o777, 0o600);
});

test('R02 partial receive failure and restart preserve model deduplication', async t => {
  const f = await fixture(t), m = new ReviewModel(); let fail = true;
  const change = { ...record(), method: 'item/completed', type: 'fileChange', itemId: 'item', status: 'completed', changes: [{ path: path.join(f.workspace, 'file.txt'), kind: { type: 'update' }, diff: '--- a\n+++ a\n@@ -1 +1 @@\n-old\n+new\n', snapshot: { disk: 'new\n', text: 'new\n', mode: 0o644 } }] };
  const { connection } = await connectionFor(t, f, async e => {
    m.receive(e);
    if (fail) throw new Error('retry after receive');
  });
  await atomic(path.join(f.store, 'events', '001-change.json'), { version: 1, records: [change] });
  await atomic(path.join(f.store, 'events', '002-complete.json'), { version: 1, records: [{ ...record(), method: 'turn/completed' }] });
  await connection.drain();
  assert.equal(m.entries().length, 1);
  connection.dispose(); fail = false;
  const restored = new ReviewModel(JSON.parse(JSON.stringify(m.save())));
  const next = await connectionFor(t, f, async e => restored.receive(e));
  await next.connection.drain(); await next.connection.drain();
  const entry = restored.entries()[0];
  assert.equal(restored.entries().length, 1); assert.equal(entry.turn.seen.length, 1);
  assert.equal(entry.file.baseline, 'old\n'); assert.equal(entry.file.expected, 'new\n'); assert.equal(entry.turn.running, false);
});

test('R02 a quarantine storage failure does not block independent valid events', async t => {
  const f = await fixture(t), received = [], { connection, errors } = await connectionFor(t, f, async e => received.push(e));
  await atomic(path.join(f.store, 'events', '001-invalid.json'), {});
  await atomic(path.join(f.store, 'events', '002-valid.json'), { version: 1, records: [record()] });
  await fs.writeFile(path.join(f.store, 'event-quarantine'), 'not a directory');
  await connection.drain(); await connection.drain();
  assert.deepEqual(received, [record()]); assert.equal(errors.length, 1);
  assert.match(errors[0].message, /could not be quarantined/);
  assert.equal(connection.status().incomplete, true);
  assert.ok(await fs.stat(path.join(f.store, 'events', '001-invalid.json')));
});

test('R03 invalid action/path records do not hide valid Keep or other sessions', async t => {
  const f = await fixture(t), dir = path.join(f.store, 'feedback', hash('session'));
  await atomic(path.join(dir, '001-valid.json'), { action: 'accept', path: path.join(f.workspace, 'kept.txt') });
  for (const [i, data] of [null, { action: 'erase', path: path.join(f.workspace, 'bad.txt') }, { action: 'reject', path: '../outside' }, { action: 'reject', path: path.join(f.root, 'outside') }].entries()) await atomic(path.join(dir, 'bad-' + i + '.json'), data);
  const other = path.join(f.store, 'feedback', hash('other'), '001-valid.json');
  await atomic(other, { action: 'reject', path: path.join(f.workspace, 'other.txt') });
  const response = await handle(f.store, prompt(f));
  assert.match(response.hookSpecificOutput.additionalContext, /1 kept, 0 undone/);
  await deliver(response, async () => {});
  assert.deepEqual(await fs.readdir(dir), []); assert.ok(await fs.stat(other));
  const next = await handle(f.store, { ...prompt(f), session_id: 'other' });
  assert.match(next.hookSpecificOutput.additionalContext, /0 kept, 1 undone/);
  assert.match(next.hookSpecificOutput.additionalContext, /other.txt/);
});

test('R03 preparation/serialization/output failures preserve decisions for the next prompt', async t => {
  const f = await fixture(t), dir = path.join(f.store, 'feedback', hash('session'));
  const first = path.join(dir, '001-first.json'), second = path.join(dir, '002-second.json');
  await atomic(first, { action: 'reject', path: path.join(f.workspace, 'one.txt') });
  await atomic(second, { action: 'accept', path: path.join(f.workspace, 'two.txt') });
  const open = fs.open;
  const mocked = t.mock.method(fs, 'open', async (...args) => {
    if (args[0] === second) throw Object.assign(new Error('temporary read failure'), { code: 'EIO' });
    return open(...args);
  });
  await assert.rejects(handle(f.store, prompt(f)), { code: 'EIO' });
  assert.equal((await fs.readdir(dir)).length, 2); mocked.mock.restore();
  const response = await handle(f.store, prompt(f));
  response.toJSON = () => { throw new Error('serialization failed'); };
  await assert.rejects(deliver(response, async () => assert.fail('must serialize first')), /serialization failed/);
  delete response.toJSON;
  await assert.rejects(deliver(response, async () => { throw new Error('stdout failed'); }), /stdout failed/);
  assert.equal((await fs.readdir(dir)).length, 2);
  const repeat = await handle(f.store, { ...prompt(f), turn_id: 'retry' });
  assert.deepEqual(repeat, response, 'Unfinished delivery repeats with the same batch ID');
  await deliver(repeat, async () => {}); assert.deepEqual(await handle(f.store, prompt(f)), {});
});

test('R03 real writable stdout errors leave feedback retryable', async t => {
  const f = await fixture(t), file = path.join(f.store, 'feedback', hash('session'), '001-reject.json');
  await atomic(file, { action: 'reject', path: path.join(f.workspace, 'one.txt') });
  const stdout = new Writable({ write(chunk, encoding, callback) { callback(Object.assign(new Error('closed pipe'), { code: 'EPIPE' })); } });
  assert.equal(await run(f.store, { stdin: Readable.from([JSON.stringify(prompt(f))]), stdout, stderr: new Writable({ write(chunk, encoding, cb) { cb(); } }) }), false);
  assert.ok(await fs.stat(file));
  let output = '';
  const successful = new Writable({ write(chunk, encoding, cb) { output += chunk; cb(); } });
  assert.equal(await run(f.store, { stdin: Readable.from([JSON.stringify(prompt(f))]), stdout: successful }), true);
  assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /0 kept, 1 undone/);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('R03 cleanup failure after output never corrupts the already written JSON', async t => {
  const f = await fixture(t), dir = path.join(f.store, 'feedback', hash('session'));
  await atomic(path.join(dir, '001-first.json'), { action: 'reject', path: path.join(f.workspace, 'one.txt') });
  const second = path.join(dir, '002-second.json');
  await atomic(second, { action: 'reject', path: path.join(f.workspace, 'two.txt') });
  const unlink = fs.unlink;
  const mocked = t.mock.method(fs, 'unlink', async (...args) => {
    if (args[0] === second) throw Object.assign(new Error('temporary cleanup failure'), { code: 'EIO' });
    return unlink(...args);
  });
  let output = '';
  assert.equal(await run(f.store, {
    stdin: Readable.from([JSON.stringify(prompt(f))]),
    stdout: new Writable({ write(chunk, encoding, callback) { output += chunk; callback(); } }),
    stderr: new Writable({ write(chunk, encoding, callback) { callback(); } })
  }), false);
  assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /0 kept, 2 undone/);
  assert.ok(await fs.stat(second)); mocked.mock.restore();
  const retry = await handle(f.store, prompt(f));
  assert.match(retry.hookSpecificOutput.additionalContext, /0 kept, 1 undone/);
  await deliver(retry, async () => {});
});

test('R03 feedback is retained until the stdout write callback succeeds', async t => {
  const f = await fixture(t), file = path.join(f.store, 'feedback', hash('session'), '001-first.json');
  await atomic(file, { action: 'reject', path: path.join(f.workspace, 'one.txt') });
  let finish, started;
  const writing = new Promise(resolve => { started = resolve; });
  const stdout = new Writable({ write(chunk, encoding, callback) { finish = callback; started(); } });
  const running = run(f.store, { stdin: Readable.from([JSON.stringify(prompt(f))]), stdout });
  await writing; assert.ok(await fs.stat(file)); finish();
  assert.equal(await running, true); await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('R03 a batch beyond 2000 decisions is carried into the next prompt', async t => {
  const f = await fixture(t), dir = path.join(f.store, 'feedback', hash('session'));
  for (let i = 0; i < 2001; i++) await atomic(path.join(dir, String(i).padStart(4, '0') + '-decision.json'), { action: 'reject', path: path.join(f.workspace, 'file.txt') });
  const first = await handle(f.store, prompt(f));
  assert.match(first.hookSpecificOutput.additionalContext, /0 kept, 2000 undone/);
  await deliver(first, async () => {});
  assert.equal((await fs.readdir(dir)).length, 1);
  const second = await handle(f.store, prompt(f));
  assert.match(second.hookSpecificOutput.additionalContext, /0 kept, 1 undone/);
  await deliver(second, async () => {});
  assert.deepEqual(await handle(f.store, prompt(f)), {});
});
