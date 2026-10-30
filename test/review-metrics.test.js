'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRequestHistory } = require('../review-metrics');
test('R16 interleaved requests keep independent deduplicated skipped counts', () => {
  const history = createRequestHistory(), a = history.use('a'); history.skip(a, 'command');
  const b = history.use('b'); history.skip(b, 'other'); history.skip(b, 'another');
  assert.equal(history.use('a'), a); history.skip(a, 'command'); assert.equal(a.skipped.size, 1); assert.equal(b.skipped.size, 2);
});
test('R16 metric retention is bounded and saturated counts explicitly become a lower bound', () => {
  const history = createRequestHistory({ maxRequests: 2, maxIds: 2 }), a = history.use('a');
  for (const id of ['one', 'two', 'three', 'one']) history.skip(a, id);
  assert.equal(a.skipped.size, 2); assert.equal(a.skippedAtLeast, true);
  history.use('b'); history.use('c'); assert.equal(history.size(), 2); assert.notEqual(history.use('a'), a);
  assert.ok([...a.skipped].every(id => /^[a-f0-9]{64}$/.test(id)), 'No raw tool IDs retained in metrics');
});
