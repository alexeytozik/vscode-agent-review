'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ReviewModel } = require('../review-model');
const { createPatch } = require('diff');
function change(itemId, full = '/tmp/retention.txt', before = 'old\n', after = 'new\n', turnId = 'turn') {
  return { method: 'item/completed', type: 'fileChange', threadId: 'thread', turnId, itemId, status: 'completed', changes: [{ path: full, kind: { type: 'update' }, diff: createPatch(full, before, after), snapshot: { text: after, disk: after, mode: 0o644 } }] };
}
function finish(m, turnId = 'turn') { m.receive({ method: 'turn/completed', threadId: 'thread', turnId }); }
function keep(entry, m) { entry.file.baseline = m.decide(entry.turn.key, entry.file.path, entry.revision, entry.hunks[0].id, 'accept').baseline; }

test('R05 resolved payloads disappear from both partial snapshots and in-memory files', () => {
  const m = new ReviewModel(); m.receive(change('one')); m.receive(change('two', '/tmp/other.txt')); finish(m);
  keep(m.entries()[0], m);
  assert.equal(m.save().turns[0].files.length, 1);
  m.compact(); assert.equal(m.turns.get('thread/turn').files.size, 1);
  keep(m.entries()[0], m); m.compact();
  assert.equal(m.turns.size, 0); assert.equal(m.save().turns.length, 0);
  assert.ok(!JSON.stringify(m.save()).includes('old\\n'));
});
test('R05 duplicate old events stay ignored after pruning and restart; a new operation in the same request is captured', () => {
  let m = new ReviewModel(); const first = change('one'); m.receive(first); finish(m); keep(m.entries()[0], m); m.compact();
  m = new ReviewModel(JSON.parse(JSON.stringify(m.save())));
  m.receive({ ...first, method: 'item/started' }); m.receive(first); finish(m);
  assert.equal(m.entries().length, 0); assert.equal(m.operations.size, 0);
  m.receive(change('two', '/tmp/retention.txt', 'new\n', 'next\n')); finish(m);
  assert.equal(m.entries()[0].file.baseline, 'new\n'); assert.equal(m.entries()[0].file.expected, 'next\n');
});
test('R05 running requests, unresolved conflicts and another request with the same path survive compaction', () => {
  const m = new ReviewModel(); m.receive(change('one')); m.receive(change('two', '/tmp/retention.txt', 'new\n', 'later\n', 'other')); finish(m, 'other');
  m.entries('thread/other')[0].file.error = 'Manual conflict';
  m.compact(); assert.equal(m.turns.size, 2); assert.ok(m.turns.get('thread/turn').running);
  assert.equal(m.entries('thread/other')[0].file.error, 'Manual conflict');
});
test('R05 completed deduplication metadata is bounded without evicting pending payloads', () => {
  const m = new ReviewModel(); m.receive(change('pending', '/tmp/pending.txt', 'old\n', 'new\n', 'pending')); finish(m, 'pending');
  for (let i = 0; i < 600; i++) { const id = 'done-' + i; m.receive(change('item', '/tmp/resolved.txt', 'old\n', 'new\n', id)); finish(m, id); keep(m.entries('thread/' + id)[0], m); m.compact(); }
  assert.equal(m.turns.size, 1); assert.equal(m.entries()[0].turn.id, 'pending');
  assert.ok(m.save().retired.length <= 512);
  assert.ok(m.save().retired.reduce((n, t) => n + t.seen.length, 0) <= 4096);
});
test('R18 a late PostToolUse for a completed request does not become an endless running request', () => {
  let model = new ReviewModel(); model.receive({ method: 'turn/started', threadId: 'thread', turnId: 'turn' }); finish(model); model.compact();
  model = new ReviewModel(model.save()); model.receive(change('late'));
  const entry = model.entries()[0]; assert.equal(entry.turn.running, false); assert.ok(model.decide(entry.turn.key, entry.file.path, entry.revision, entry.hunks[0].id, 'accept'));
});
