'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ReviewModel } = require('../review-model');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createStateStore, validateState } = require('../review-state');

const state = () => ({ version: 2, turns: [{ key: 'thread/turn', threadId: 'thread', id: 'turn', created: 1, running: false, warnings: [], seen: ['item'], files: [
  { path: '/workspace/file.txt', canonical: '/workspace/file.txt', baseline: 'before\n', expected: 'after\n', mode: 0o644 }
] }] });

for (const [name, corrupt] of [
  ['missing key', s => delete s.turns[0].key], ['mismatched key', s => s.turns[0].key = 'other/turn'],
  ['warnings', s => s.turns[0].warnings = 'shell'], ['seen', s => s.turns[0].seen = [null]],
  ['created', s => s.turns[0].created = -1], ['mode', s => s.turns[0].files[0].mode = '755'],
  ['canonical', s => s.turns[0].files[0].canonical = 'relative'], ['error', s => s.turns[0].files[0].error = {}],
  ['duplicate turn', s => s.turns.push(structuredClone(s.turns[0]))], ['duplicate file', s => s.turns[0].files.push(structuredClone(s.turns[0].files[0]))],
  ['nul path', s => s.turns[0].files[0].path += '\0'], ['outside workspace', s => s.turns[0].files[0].path = '/outside/file.txt']
]) test('R04 rejects invalid saved ' + name, () => {
  const saved = state(); corrupt(saved);
  assert.throws(() => new ReviewModel(saved, { root: '/workspace' }), /Invalid/);
});

test('R04 recovery keeps valid neighbouring requests and files without trusting invalid paths', () => {
  const saved = state();
  saved.turns.push({ id: 'broken', threadId: 'thread', files: [] });
  saved.turns[0].files.push({ ...saved.turns[0].files[0], path: '/outside/unsafe.txt' });
  const model = new ReviewModel(saved, { root: '/workspace', recover: true });
  assert.equal(model.entries().length, 1);
  assert.equal(model.entries()[0].file.path, '/workspace/file.txt');
  assert.equal(model.restoreIssues.length, 2);
  const entry = model.entries()[0];
  assert.equal(model.decide(entry.turn.key, entry.file.path, entry.revision, entry.hunks[0].id, 'reject').current, 'before\n');
});

test('R04 accepts the selected workspace alias as well as its canonical root', () => {
  const saved = state(); saved.turns[0].files[0].canonical = '/real/workspace/file.txt';
  const model = new ReviewModel(saved, { root: '/real/workspace', aliases: ['/workspace'] });
  assert.equal(model.entries().length, 1);
  saved.turns[0].files[0].path = '/workspace-other/file.txt';
  assert.throws(() => new ReviewModel(saved, { root: '/real/workspace', aliases: ['/workspace'] }), /Invalid/);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-state.'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'request-review.json');
  return { root, file, store: createStateStore(file) };
}
test('R04 malformed JSON is preserved before replacement and loads normally after restart', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, '{broken');
  await assert.rejects(f.store.load(), /Malformed JSON/);
  await f.store.save(state());
  assert.equal(await fs.readFile(f.store.status().backup, 'utf8'), '{broken');
  assert.equal((await fs.stat(f.store.status().backup)).mode & 0o777, 0o600);
  const next = await createStateStore(f.file).load();
  assert.equal(next.state.turns.length, 1); assert.deepEqual(next.issues, []);
});
test('R04 partial recovery preserves the complete original before saving valid neighbours', async t => {
  const f = await fixture(t), saved = state(); saved.turns.push({ id: 'broken' });
  const original = JSON.stringify(saved); await fs.writeFile(f.file, original);
  const restored = await f.store.load(); assert.equal(restored.issues.length, 1);
  await f.store.save(restored.state);
  assert.equal(await fs.readFile(f.store.status().backup, 'utf8'), original);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).turns.length, 1);
});
test('R04 failed backup never overwrites a damaged queue; retry can recover', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, '{'); await assert.rejects(f.store.load());
  const copy = t.mock.method(fs, 'copyFile', async () => { throw Object.assign(new Error('read only'), { code: 'EROFS' }); });
  await assert.rejects(f.store.save(state()), { code: 'EROFS' });
  assert.equal(await fs.readFile(f.file, 'utf8'), '{'); assert.equal(f.store.status().blocked, true);
  copy.mock.restore(); await f.store.save(state());
  assert.equal(await fs.readFile(f.store.status().backup, 'utf8'), '{');
});
test('R04 missing cache and unsupported versions are distinct from normal restoration', async t => {
  const f = await fixture(t); assert.deepEqual(await f.store.load(), { state: { version: 2, turns: [] }, issues: [] });
  await fs.writeFile(f.file, JSON.stringify({ ...state(), version: 99 }));
  const recovered = await f.store.load(); assert.equal(recovered.state.turns.length, 0); assert.equal(recovered.issues.length, 1);
  await f.store.save(recovered.state); assert.equal(JSON.parse(await fs.readFile(f.store.status().backup, 'utf8')).version, 99);
});
test('R04 saved queue symlinks are neither read nor overwritten', async t => {
  const f = await fixture(t), target = path.join(f.root, 'target'); await fs.writeFile(target, 'untouched'); await fs.symlink(target, f.file);
  await assert.rejects(f.store.load()); await assert.rejects(f.store.save(state()), /not a regular file/);
  assert.equal(await fs.readFile(target, 'utf8'), 'untouched'); assert.equal((await fs.lstat(f.file)).isSymbolicLink(), true);
});
test('R04 live pending records below 40 MiB round-trip beyond old arbitrary array limits', () => {
  const model = new ReviewModel();
  for (let batch = 0; batch < 11; batch++) {
    const count = batch === 10 ? 1 : 200;
    model.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'thread', turnId: 'turn', itemId: 'batch-' + batch,
      changes: Array.from({ length: count }, (_, i) => ({ path: '/workspace/' + (batch * 200 + i), kind: { type: 'add' }, diff: '', snapshot: { disk: '', text: '', mode: 0o644 } })) });
  }
  for (let i = 0; i < 10001; i++) model.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'thread', turnId: 'turn', itemId: 'empty-' + i, changes: [] });
  const saved = model.save(); assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 40 * 1024 * 1024);
  const restored = validateState(saved, { root: '/workspace', recover: true });
  assert.deepEqual(restored.issues, []); assert.equal(restored.state.turns[0].files.length, 2001);
  assert.equal(restored.state.turns[0].seen.length, 10012);
  assert.equal(new ReviewModel(restored.state).entries().length, 2001);
});
test('R04 transient read failures forbid replacement and recover by rereading the original', async t => {
  const f = await fixture(t), original = JSON.stringify(state()); await fs.writeFile(f.file, original);
  const open = fs.open; let failed = false;
  const mock = t.mock.method(fs, 'open', async (...args) => {
    if (!failed && args[0] === f.file) { failed = true; throw Object.assign(new Error('temporary read'), { code: 'EIO' }); }
    return open(...args);
  });
  await assert.rejects(f.store.load(), { code: 'EIO' });
  assert.equal(f.store.status().retry, true);
  await assert.rejects(f.store.save({ version: 2, turns: [] }), /read/);
  assert.equal(await fs.readFile(f.file, 'utf8'), original); assert.equal(f.store.status().backup, undefined);
  mock.mock.restore(); const loaded = await f.store.load();
  assert.equal(loaded.state.turns.length, 1); assert.equal(f.store.status().retry, false);
  await f.store.save(loaded.state); assert.equal(f.store.status().backup, undefined);
});
