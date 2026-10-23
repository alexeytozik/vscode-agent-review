'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { actions, decisionGate } = require('../public-controls');
test('controls for long changes anchor at their first line', () => {
  const arg={turn:'t',path:'/tmp/file',revision:'one',hunk:'h'};
  const controls=actions([{start:1,end:150,arg}]);
  assert.deepEqual(controls.map(c=>[c.line,c.command]),[[0,'changeReview.accept'],[0,'changeReview.reject']]);
  assert.ok(controls.every(c=>c.arguments[0]===arg));
});
test('duplicate and competing decisions share the in-flight operation', async () => {
  let release, calls=0;
  const gate=decisionGate(async()=>{calls++;await new Promise(r=>release=r);return 'done';});
  const arg={turn:'t',path:'/tmp/file',revision:'one',hunk:'h'};
  const first=gate(arg,'accept'),second=gate({...arg},'reject');
  assert.equal(first,second);await new Promise(setImmediate);assert.equal(calls,1);release();assert.equal(await first,'done');
});
test('a failed decision releases its lock', async () => {
  let calls=0;const gate=decisionGate(async()=>{if(++calls===1)throw Error('conflict');return 'done';});const arg={turn:'t',path:'p',revision:'r',hunk:'h'};
  await assert.rejects(gate(arg,'reject'),/conflict/);assert.equal(await gate(arg,'reject'),'done');
});
test('separate revisions do not share a decision', async () => {
  const gate=decisionGate(async arg=>arg.revision);const arg={turn:'t',path:'p',revision:'one',hunk:'h'};
  assert.deepEqual(await Promise.all([gate(arg,'accept'),gate({...arg,revision:'two'},'reject')]),['one','two']);
});
