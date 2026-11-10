'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareStateFixture } = require('./state-fixtures');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-state-fixtures.')));
  const user = path.join(root, 'user'), storage = path.join(user, 'storage'), cache = path.join(storage, 'request-review.json');
  await fs.mkdir(storage, { recursive: true });
  const saved = { version: 2, turns: [{ key: 'request', files: [{ path: path.join(root, 'workspace', 'safe.txt'), expected: 'before shutdown\n' }] }] };
  await fs.writeFile(cache, JSON.stringify(saved));
  t.after(async () => { await fs.chmod(storage, 0o700).catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return { root, user, storage, cache, saved, result: { passed: true, stateFixture: storage } };
}

test('restart corruption is applied explicitly after the editor phase, preserving its final archive until then', async t => {
  const f = await fixture(t);
  // A still-running editor can save again after producing its result.
  await fs.writeFile(f.cache, JSON.stringify({ ...f.saved, lastWrite: 'shutdown' }));
  assert.equal(JSON.parse(await fs.readFile(f.cache, 'utf8')).lastWrite, 'shutdown');
  await prepareStateFixture('state', f.result, f.user);
  assert.equal(await fs.readFile(f.cache, 'utf8'), '{');
});

test('partial recovery corruption preserves the final shutdown contents of valid neighbours', async t => {
  const f = await fixture(t);
  f.saved.turns[0].files[0].expected = 'final shutdown write\n';
  f.saved.turns[0].seen = ['late event'];
  await fs.writeFile(f.cache, JSON.stringify(f.saved));
  await prepareStateFixture('state-corrupt', f.result, f.user);
  const mixed = JSON.parse(await fs.readFile(f.cache, 'utf8'));
  assert.deepEqual(mixed.turns[0].files[0], f.saved.turns[0].files[0]);
  assert.deepEqual(mixed.turns[0].seen, ['late event']);
  assert.equal(mixed.turns[0].files[1].path, path.join(f.root, 'outside.txt'));
  assert.deepEqual(mixed.turns[1], { id: 'broken', files: [] });
});

test('read-only restart fixture changes permissions without rewriting the queue', async t => {
  const f = await fixture(t), before = await fs.readFile(f.cache);
  await fs.chmod(f.storage, 0o750);
  const cleanup = await prepareStateFixture('state-partial', f.result, f.user);
  t.after(cleanup);
  assert.equal((await fs.stat(f.storage)).mode & 0o777, 0o500);
  assert.deepEqual(await fs.readFile(f.cache), before);
  await cleanup(); await cleanup();
  assert.equal((await fs.stat(f.storage)).mode & 0o777, 0o750);
});

test('read-only cleanup restores the original directory even if its path becomes an outside symlink', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'), moved = path.join(f.user, 'moved-storage');
  await fs.mkdir(outside, { mode: 0o711 }); await fs.chmod(f.storage, 0o750);
  const cleanup = await prepareStateFixture('state-partial', f.result, f.user);
  let renamed = false, linked = false;
  try {
    // Simulate another writer changing permissions and replacing the pathname.
    await fs.chmod(f.storage, 0o700); await fs.rename(f.storage, moved); renamed = true;
    await fs.symlink(outside, f.storage); linked = true;
    await cleanup();
    assert.equal((await fs.stat(moved)).mode & 0o777, 0o750);
    assert.equal((await fs.stat(outside)).mode & 0o777, 0o711);
  } finally {
    await cleanup();
    if (linked) await fs.unlink(f.storage);
    if (renamed) await fs.rename(moved, f.storage);
  }
});

test('later phases do not repeat a transition or require a fixture', async t => {
  const f = await fixture(t), before = await fs.readFile(f.cache);
  for (const phase of ['state-readonly', 'state-transient', 'state-resume']) await prepareStateFixture(phase, { passed: true }, f.user);
  assert.deepEqual(await fs.readFile(f.cache), before);
});

test('missing phase result and fixtures outside the isolated profile cannot mutate archives', async t => {
  const f = await fixture(t), before = await fs.readFile(f.cache);
  await assert.rejects(prepareStateFixture('state', { passed: true }, f.user), /did not provide/);
  await assert.rejects(prepareStateFixture('state', { ...f.result, passed: false }, f.user), /did not provide/);
  await assert.rejects(prepareStateFixture('state', f.result, path.join(f.user, 'storage')), /outside/);
  assert.deepEqual(await fs.readFile(f.cache), before);
});

test('a queue symlink cannot redirect a transition to another file', async t => {
  const f = await fixture(t), target = path.join(f.root, 'target.json');
  await fs.writeFile(target, 'preserve\n'); await fs.unlink(f.cache); await fs.symlink(target, f.cache);
  await assert.rejects(prepareStateFixture('state', f.result, f.user), /regular queue/);
  assert.equal(await fs.readFile(target, 'utf8'), 'preserve\n');
});
