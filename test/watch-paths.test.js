'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createWatchIndex } = require('../watch-paths');

test('nonrecursive watcher events resolve parent aliases to the original pending paths', () => {
  const file = { path: '/private/var/project/pending.txt', canonical: '/private/var/project/pending.txt' };
  const index = createWatchIndex([file], 'linux');
  assert.deepEqual([...index.get('/private/var/project', '/var/project/pending.txt')], [file.path]);
  assert.equal(index.get('/var/project', '/var/project/pending.txt'), undefined, 'The callback uses its registered directory');
});

test('canonical and lexical basenames both resolve to the exact saved path', () => {
  const file = { path: '/workspace/Alias.TXT', canonical: '/real/workspace/actual.txt' };
  const index = createWatchIndex([file], 'linux');
  for (const name of ['Alias.TXT', 'actual.txt']) assert.deepEqual([...index.get('/workspace', '/provider/' + name)], [file.path]);
});

test('case aliases are accepted only on the supported case-preserving platforms', () => {
  for (const platform of ['darwin', 'win32']) {
    const index = createWatchIndex([{ path: '/workspace/File.txt' }], platform);
    assert.deepEqual([...index.get('/workspace', '/WORKSPACE/FILE.TXT')], ['/workspace/File.txt']);
  }
  assert.equal(createWatchIndex([{ path: '/workspace/File.txt' }], 'linux').get('/workspace', '/workspace/file.txt'), undefined);
});

test('an exact basename separates genuinely different case-sensitive files before case fallback', () => {
  const index = createWatchIndex([{ path: '/workspace/A.txt' }, { path: '/workspace/a.txt' }], 'darwin');
  assert.deepEqual([...index.get('/workspace', '/alias/A.txt')], ['/workspace/A.txt']);
  assert.deepEqual([...index.get('/workspace', '/alias/a.txt')], ['/workspace/a.txt']);
});

test('aliases are deduplicated, separate directories stay separate, and unknown names never become read paths', () => {
  const index = createWatchIndex([{ path: '/workspace/a/file.txt', canonical: '/workspace/a/file.txt' }, { path: '/workspace/b/file.txt' }], 'linux');
  assert.deepEqual([...index.get('/workspace/a', '/outside/file.txt')], ['/workspace/a/file.txt'], 'Only the known pending path is returned, never an event URI');
  assert.equal(index.get('/workspace/a', '/outside/unknown.txt'), undefined);
  assert.equal(index.get('/outside', '/workspace/a/file.txt'), undefined);
});

test('delete, rename-away and create-again events keep resolving the original pending filename', () => {
  const index = createWatchIndex([{ path: '/workspace/original.txt' }], 'linux');
  assert.deepEqual([...index.get('/workspace', '/alias/original.txt')], ['/workspace/original.txt']);
  assert.equal(index.get('/workspace', '/alias/renamed.txt'), undefined);
  assert.deepEqual([...index.get('/workspace', '/alias/original.txt')], ['/workspace/original.txt']);
  assert.equal(createWatchIndex([], 'linux').get('/workspace', '/alias/original.txt'), undefined, 'A rebuilt index does not retain resolved files');
});

function scheduler() {
  const source = fs.readFileSync(require.resolve('../review'), 'utf8'), start = source.indexOf('  function schedule(full) {'), end = source.indexOf('  async function scheduleDocument(', start);
  assert.ok(start >= 0 && end > start);
  const timers = new Map(), calls = [], trackedPaths = new Set(['/workspace/known.txt']), canonicalPaths = new Map([['/real/known.txt', new Set(['/workspace/known.txt'])]]), dirtyPaths = new Set();
  let now = 0, id = 0;
  const module = { exports: {} };
  vm.runInNewContext(source.slice(start, end) + '\nmodule.exports = schedule;', {
    module, Set, timer: undefined, enabled: () => true, trackedPaths, canonicalPaths, dirtyPaths,
    setTimeout: (run, delay) => { const key = ++id; timers.set(key, { run, at: now + delay }); return key; }, clearTimeout: key => timers.delete(key),
    exclusive: work => Promise.resolve(work()), refresh: paths => calls.push([...paths]), report: error => { throw error; }
  });
  function advance(time) {
    for (;;) {
      const ready = [...timers].filter(([, job]) => job.at <= time).sort((a, b) => a[1].at - b[1].at)[0];
      if (!ready) break;
      timers.delete(ready[0]); now = ready[1].at; ready[1].run();
    }
    now = time;
  }
  return { schedule: module.exports, advance, calls, timers };
}

test('unrelated events cannot postpone an already scheduled pending-file refresh', () => {
  const f = scheduler(); f.schedule('/workspace/known.txt');
  for (let time = 20; time <= 240; time += 20) { f.advance(time); f.schedule('/workspace/unrelated.txt'); }
  f.advance(250); assert.deepEqual(f.calls, [['/workspace/known.txt']]); assert.equal(f.timers.size, 0);
});

test('a known-path burst remains coalesced and canonical aliases never duplicate reads', () => {
  const f = scheduler();
  for (let time = 0; time <= 100; time += 20) { f.advance(time); f.schedule(time % 40 ? '/real/known.txt' : '/workspace/known.txt'); }
  f.advance(349); assert.equal(f.calls.length, 0);
  f.advance(350); assert.deepEqual(f.calls, [['/workspace/known.txt']]);
  f.schedule('/outside/unrelated.txt'); f.advance(1000); assert.equal(f.calls.length, 1);
});
