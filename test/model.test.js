'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPatch } = require('diff');
const { ReviewModel, rebase, transition } = require('../review-model');
function event(before, after, extra = {}) {
  return { method: 'item/completed', type: 'fileChange', threadId: 'thread', turnId: 'turn', itemId: 'item', status: 'completed', changes: [{ path: '/tmp/example.txt', kind: { type: before === null ? 'add' : after === null ? 'delete' : 'update' }, diff: createPatch('example', before || '', after || ''), snapshot: { disk: after, text: after, mode: 0o755 } }], ...extra };
}
test('actual event reconstructs baseline and keeps independent blocks', () => {
  const m = new ReviewModel();
  m.receive(event('one\nunchanged\nthree\n', 'ONE\nunchanged\nTHREE\n'));
  m.receive({ method: 'turn/completed', threadId: 'thread', turnId: 'turn' });
  const entry = m.entries()[0]; assert.equal(entry.hunks.length, 2);
  const accepted = m.decide(entry.turn.key, entry.file.path, entry.revision, entry.hunks[0].id, 'accept');
  entry.file.baseline = accepted.baseline;
  const next = m.entries()[0];
  const rejected = m.decide(next.turn.key, next.file.path, next.revision, next.hunks[0].id, 'reject');
  assert.equal(rejected.current, 'ONE\nunchanged\nthree\n');
});
test('manual edits outside pending blocks enter both sides', () => {
  const result = rebase('old\na\nb\nc\n', 'NEW\na\nb\nc\n', 'NEW\na\nb\nmanual\n');
  assert.equal(result.baseline, 'old\na\nb\nmanual\n');
  assert.equal(result.expected, 'NEW\na\nb\nmanual\n');
  const shift = rebase('a\nb\nc\nold\n', 'a\nb\nc\nNEW\n', 'extra\na\nb\nc\nNEW\n');
  assert.equal(shift.baseline, 'extra\na\nb\nc\nold\n');
});
test('overlapping manual edit fails closed', () => assert.throws(() => rebase('old\n', 'NEW\n', 'manual\n'), /overlaps/));
test('file lifecycle conflicts explain the changed state and preserve the pending snapshot', () => {
  assert.throws(() => rebase('old\n', 'NEW\n', null), /removed after this request/);
  assert.throws(() => rebase('old\n', null, 'recreated\n'), /recreated after this request/);
  assert.throws(() => rebase(null, 'new\n', 'later\n'), /new file has later edits/);
  const m = new ReviewModel(); m.receive(event('old\n', 'NEW\n'));
  const file = m.entries()[0].file;
  file.error = 'File creation or deletion overlaps with later edits.';
  m.refresh('thread/turn', file.path, null);
  assert.match(file.error, /removed after this request/);
  assert.equal(file.baseline, 'old\n'); assert.equal(file.expected, 'NEW\n');
  m.refresh('thread/turn', file.path, 'NEW\n');
  assert.equal(file.error, undefined);
});
test('later operations combine and preserve intervening manual edits', () => {
  const m = new ReviewModel();
  m.receive(event('old\na\nb\nc\n', 'NEW\na\nb\nc\n'));
  m.receive(event('NEW\na\nb\nmanual\n', 'NEW\nA\nb\nmanual\n', { itemId: 'second' }));
  assert.equal(m.entries()[0].file.baseline, 'old\na\nb\nmanual\n');
  assert.equal(m.entries()[0].file.expected, 'NEW\nA\nb\nmanual\n');
});
test('turns do not mix, duplicate events are ignored, running actions denied', () => {
  const m = new ReviewModel(), e = event('a\n', 'A\n'); m.receive(e); m.receive(e);
  assert.equal(m.turns.size, 1); assert.equal(m.entries().length, 1);
  const f = m.entries()[0]; assert.throws(() => m.decide(f.turn.key, f.file.path, f.revision, f.hunks[0].id, 'reject'), /finish/);
  m.receive(event('b\n', 'B\n', { turnId: 'other', itemId: 'other' })); assert.equal(m.turns.size, 2);
  const restored = new ReviewModel(m.save()); assert.equal(restored.entries().length, 2); assert.ok(restored.entries().every(e => !e.turn.running));
});
test('create, delete, CRLF and no final newline reconstruct exactly', () => {
  for (const [before, after] of [[null, 'new\n'], ['gone\n', null], ['one\r\ntwo', 'ONE\r\ntwo'], ['one', 'ONE']]) {
    const e = event(before, after); const pair = transition(e.changes[0]); assert.equal(pair.before, before); assert.equal(pair.after, after);
  }
});
test('patch cannot relocate into a repeated region after a race', () => {
  const e = event('old\nsame\nold\n', 'NEW\nsame\nold\n');
  e.changes[0].snapshot = { disk: 'manual\nsame\nNEW\n', text: 'manual\nsame\nNEW\n' };
  const m = new ReviewModel(); m.receive(e); assert.ok(m.entries()[0].file.error);
});
test('unsafe snapshots and shell coverage are visible', () => {
  const m = new ReviewModel(), e = event('old\n', 'new\n'); e.changes[0].snapshot = { error: 'Binary' }; m.receive(e);
  m.receive({ method: 'item/started', threadId: 'thread', turnId: 'turn', type: 'commandExecution', readOnly: false });
  assert.equal(m.entries()[0].file.error, 'Binary'); assert.ok(m.entries()[0].turn.warnings.includes('shell'));
});
test('rename is represented as verified deletion and creation', () => {
  const m = new ReviewModel();
  const e = event('one\n', 'ONE\n'); e.changes[0].kind.move_path = '/tmp/renamed.txt';
  e.method = 'item/started'; e.changes[0].snapshot = { disk: 'one\n', text: 'one\n', mode: 0o755 }; e.changes[0].destinationSnapshot = { disk: null, text: null };
  m.receive(e);
  const completed = structuredClone(e); completed.method = 'item/completed'; completed.changes[0].snapshot = { disk: null, text: null }; completed.changes[0].destinationSnapshot = { disk: 'ONE\n', text: 'ONE\n' };
  m.receive(completed);
  assert.equal(m.entries().length, 2);
  assert.equal(m.entries().find(e => e.file.path === '/tmp/example.txt').file.baseline, 'one\n');
  assert.equal(m.entries().find(e => e.file.path === '/tmp/renamed.txt').file.expected, 'ONE\n');
});
test('manual shift after an insertion maps back to baseline offsets', () => {
  const r = rebase('a\nb\nc\nd\ne\n', 'INSERT\na\nb\nc\nd\ne\n', 'INSERT\na\nb\nc\nd\nmanual\n');
  assert.equal(r.baseline, 'a\nb\nc\nd\nmanual\n');
});
test('empty files are actionable only with sufficient evidence', () => {
  const create = event(null, '').changes[0]; create.diff = '';
  assert.deepEqual(transition(create).before, null);
  const remove = event('', null).changes[0]; remove.diff = '';
  assert.equal(transition(remove, { disk: '', mode: 0o755 }).before, '');
  assert.throws(() => transition(remove), /unambiguous/);
});
test('external tools leave a persistent coverage marker', () => {
  const m = new ReviewModel(); m.receive({ method: 'item/started', threadId: 'thread', turnId: 'turn', type: 'externalTool' });
  assert.ok(m.turns.get('thread/turn').warnings.includes('external'));
});
