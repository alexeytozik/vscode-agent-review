'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { diffArrays } = require('diff');
const { changes, decide, lines } = require('../core');
const source = fs.readFileSync(require.resolve('../core'), 'utf8');
const nativeNow = performance.now, nativeDateNow = Date.now, realNow = nativeNow.bind(performance);

function logicalClock(t) {
  // Structural comparisons advance both finite clocks per read. Host scheduling
  // is measured by the separate deadline checks and installed performance tests.
  let now = 0;
  const advance = () => now += 0.1;
  t.mock.method(performance, 'now', advance);
  t.mock.method(Date, 'now', () => Math.floor(advance()));
}

function instrument({ clock, fallback = diffArrays } = {}) {
  const calls = [], module = { exports: {} };
  vm.runInNewContext(source, { module, require: name => name === 'diff' ? { diffArrays: (...args) => { calls.push(args[2]); return fallback(...args); } } : name === 'node:perf_hooks' && clock ? { performance: { now: clock } } : require(name) });
  return { ...module.exports, calls };
}
function sparse(count = 1000) {
  return {
    before: Array.from({ length: count }, (_, index) => `keep-${index}\nold-${index}\nkeep-tail-${index}\n`).join(''),
    after: Array.from({ length: count }, (_, index) => `keep-${index}\nnew-${index}\nkeep-tail-${index}\n`).join('')
  };
}
function myersEdits(before, after) {
  const result = []; let pending;
  for (const part of diffArrays(lines(before), lines(after))) {
    if (!part.added && !part.removed) { if (pending) result.push(pending); pending = undefined; continue; }
    pending ||= { before: '', after: '' };
    pending[part.removed ? 'before' : 'after'] += part.value.join('');
  }
  if (pending) result.push(pending);
  return result;
}

test('1000 independent sparse replacements avoid Myers and preserve exact Keep/Undo', t => {
  logicalClock(t);
  const f = sparse(), core = instrument({ fallback: () => assert.fail('Sparse replacements must not enter Myers') });
  let before = f.before, after = f.after;
  const initial = core.changes(before, after);
  assert.equal(initial.hunks.length, 1000); assert.equal(core.calls.length, 0);
  const kept = core.decide(before, after, initial.revision, initial.hunks[400].id, 'accept');
  before = kept.baseline; assert.equal(kept.current, f.after);
  assert.equal(before, f.before.replace('old-400\n', 'new-400\n'));
  const next = core.changes(before, after), undone = core.decide(before, after, next.revision, next.hunks[700].id, 'reject');
  after = undone.current;
  assert.equal(after, f.after.replace('new-701\n', 'old-701\n'));
  assert.equal(undone.baseline, before); assert.equal(core.changes(before, after).hunks.length, 998);
});

test('sparse output matches Myers for contiguous runs, repeated anchors and exact text variants', t => {
  logicalClock(t);
  let seed = 97;
  const random = max => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
  for (let run = 0; run < 35; run++) {
    const ending = run % 2 ? '\r\n' : '\n', count = 256 + random(128);
    const old = Array.from({ length: count }, (_, index) => (index % 4 ? `original-${index}-ёж` : 'repeated anchor') + ending);
    if (run % 3 === 0) old[0] = '\uFEFF' + old[0];
    if (run % 3 === 1) old[count - 1] = old[count - 1].slice(0, -ending.length);
    const next = [...old], edited = new Set();
    while (edited.size < 80) { const index = random(count); if (index % 4) edited.add(index); }
    for (const index of edited) next[index] = `changed-${index}-🌍` + (old[index].endsWith(ending) ? ending : '');
    const before = old.join(''), after = next.join(''), actual = changes(before, after);
    assert.deepEqual(actual.hunks.map(({ before, after }) => ({ before, after })), myersEdits(before, after));
    let b = before, a = after;
    while (changes(b, a).hunks.length) {
      const diff = changes(b, a), hunk = diff.hunks[random(diff.hunks.length)];
      const rejected = decide(b, a, diff.revision, hunk.id, 'reject'); a = rejected.current;
    }
    assert.equal(a, before);
    b = before; a = after;
    while (changes(b, a).hunks.length) {
      const diff = changes(b, a), hunk = diff.hunks[random(diff.hunks.length)];
      const kept = decide(b, a, diff.revision, hunk.id, 'accept'); b = kept.baseline;
    }
    assert.equal(b, after);
  }
});

test('changed lines that occur among unchanged neighbours still use Myers', t => {
  logicalClock(t);
  const f = sparse(100);
  for (const anchor of ['old-0\n', 'new-0\n']) {
    const core = instrument(), before = f.before + anchor, after = f.after + anchor;
    const result = core.changes(before, after);
    assert.equal(core.calls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(result.hunks.map(({ before, after }) => ({ before, after })))), myersEdits(before, after));
  }
});

test('moved and repeated changed lines and unequal line counts retain the bounded Myers fallback', t => {
  logicalClock(t);
  const f = sparse(100);
  const fixtures = [
    [f.before, f.after.replace('new-0\n', 'old-1\n')],
    [f.before, f.after + 'inserted\n'],
    ['same\n'.repeat(300), 'same\n'.repeat(200) + 'changed\n'.repeat(100)],
    [Array.from({ length: 300 }, (_, index) => `row-${index}\n`).join(''), Array.from({ length: 300 }, (_, index) => `row-${299 - index}\n`).join('')]
  ];
  for (const [before, after] of fixtures) {
    const core = instrument({ fallback: () => undefined });
    assert.throws(() => core.changes(before, after), /diff is too large/);
    assert.equal(core.calls.length, 1); assert.ok(core.calls[0].timeout > 0 && core.calls[0].timeout <= 200);
    assert.equal(core.calls[0].maxEditLength, 10000);
  }
});

test('small and newline-heavy one-edit inputs avoid the sparse set-building path', t => {
  logicalClock(t);
  const core = instrument(), before = '\n'.repeat(10000) + 'old\n', after = '\n'.repeat(10000) + 'new\n';
  assert.equal(core.changes(before, after).hunks.length, 1); assert.equal(core.calls.length, 1);
  assert.equal(core.changes('old\n', 'new\n').hunks.length, 1); assert.equal(core.calls.length, 2);
});

test('linear substitutions retain the exact 10000-edit hard boundary', t => {
  logicalClock(t);
  const core = instrument({ fallback: () => assert.fail('Unambiguous replacement does not need Myers') });
  assert.equal(core.changes('old\n'.repeat(5000), 'new\n'.repeat(5000)).hunks.length, 1);
  for (const count of [5001, 6000]) assert.throws(() => core.changes('old\n'.repeat(count), 'new\n'.repeat(count)), /diff is too large/);
  assert.equal(core.calls.length, 0);
});

test('6000 displaced lines still reach Myers when their minimal edit length is only two', t => {
  logicalClock(t);
  const old = Array.from({ length: 6000 }, (_, index) => `row-${index}\n`), core = instrument();
  const result = core.changes(old.join(''), [...old.slice(1), old[0]].join(''));
  assert.equal(core.calls.length, 1); assert.equal(result.hunks.length, 2);
  assert.equal(result.hunks[0].before, old[0]); assert.equal(result.hunks[0].after, '');
  assert.equal(result.hunks[1].before, ''); assert.equal(result.hunks[1].after, old[0]);
});

test('fast-path detection and Myers share one deadline instead of restarting 200ms', t => {
  logicalClock(t);
  const f = sparse(100); let now = 0;
  const core = instrument({ clock: () => { const value = now; now += 10; return value; } });
  core.changes(f.before, f.after.replace('new-0\n', 'old-1\n'));
  assert.equal(core.calls.length, 1); assert.ok(core.calls[0].timeout > 0 && core.calls[0].timeout < 190);
});

test('exhausted sparse detection budget never starts an additional Myers attempt', () => {
  const f = sparse(100); let first = true;
  const core = instrument({ clock: () => first ? (first = false, 0) : 201 });
  assert.throws(() => core.changes(f.before, f.after), /diff is too large/); assert.equal(core.calls.length, 0);
});

test('a real 250ms pause exhausts the production deadline before Myers starts', t => {
  assert.equal(performance.now, nativeNow); assert.equal(Date.now, nativeDateNow);
  let reads = 0;
  t.mock.method(performance, 'now', () => {
    if (++reads === 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    return realNow();
  });
  const core = instrument({ fallback: () => assert.fail('An expired deadline must not enter Myers') }), start = realNow();
  assert.throws(() => core.changes('before\n', 'after\n'), /diff is too large/);
  assert.equal(core.calls.length, 0); assert.ok(realNow() - start >= 200);
});
