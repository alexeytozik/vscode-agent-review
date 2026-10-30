'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core');
const changes = core.changes;
let calls = 0;
core.changes = (...args) => { calls++; if (args[0] === 'fail\n') throw new Error('synthetic diff failure'); return changes(...args); };
const { ReviewModel } = require('../review-model');
function fixture(count = 20) {
  return new ReviewModel({ version: 2, turns: [{ key: 'thread/request', id: 'request', threadId: 'thread', created: 1, warnings: [], seen: [], files:
    Array.from({ length: count }, (_, i) => ({ path: '/workspace/' + i, baseline: 'old\n', expected: 'new\n', mode: 0o644 })) }] });
}
test('R10 unchanged queue reuses exact per-file diff; one changed file recalculates only itself', () => {
  const model = fixture(); calls = 0; model.entries(); assert.equal(calls, 20);
  for (let i = 0; i < 10; i++) model.entries(); assert.equal(calls, 20);
  const file = model.turns.get('thread/request').files.get('/workspace/0');
  file.expected = 'other\n'; const current = model.entries(); assert.equal(calls, 21);
  assert.equal(current[0].hunks[0].after, 'other\n');
  file.baseline = 'other\n'; assert.equal(model.entries().length, 19); assert.equal(calls, 22);
  file.baseline = 'old\n'; file.expected = 'new\n'; model.entries(); assert.equal(calls, 23);
});
test('R10 same path in independent requests, replacement and restore never share stale content', () => {
  const model = fixture(1), saved = model.save();
  saved.turns.push({ ...saved.turns[0], key: 'thread/another', id: 'another', files: [{ ...saved.turns[0].files[0], expected: 'independent\n' }] });
  const restored = new ReviewModel(saved); calls = 0;
  const initial = restored.entries(); assert.equal(calls, 2);
  assert.notEqual(initial[0].revision, initial[1].revision);
  const turn = restored.turns.get('thread/request'), file = turn.files.get('/workspace/0');
  turn.files.set(file.path, { ...file, expected: 'replacement\n' });
  const next = restored.entries(); assert.equal(calls, 3); assert.equal(next[0].hunks[0].after, 'replacement\n');
  assert.throws(() => restored.decide(initial[0].turn.key, file.path, initial[0].revision, initial[0].hunks[0].id, 'accept'), /changed|stale|Refresh/);
  const restart = new ReviewModel(restored.save()); calls = 0; restart.entries(); restart.entries(); assert.equal(calls, 2);
});
test('R10 cached failure stays isolated and changed exact inputs can recover', () => {
  const model = fixture(2), file = model.turns.get('thread/request').files.get('/workspace/0'); file.baseline = 'fail\n'; calls = 0;
  const first = model.entries(); assert.equal(calls, 2); assert.equal(first[0].hunks.length, 0); assert.ok(first[1].hunks.length);
  for (let i = 0; i < 10; i++) model.entries(); assert.equal(calls, 2);
  file.baseline = 'old\n'; const recovered = model.entries(); assert.equal(calls, 3); assert.ok(recovered[0].hunks.length); assert.equal(file.error, undefined);
});
