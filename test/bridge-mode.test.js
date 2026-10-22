'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('disabled bridge skips snapshots and does not capture the tail of a paused request', async () => {
  let enabled = true, handler, modeChange, reads = 0;
  const received = [], disposable = { dispose() {} };
  const vscode = {
    workspace: { getConfiguration: () => ({ get: () => enabled }), onDidChangeConfiguration: fn => { modeChange = fn; return disposable; }, textDocuments: [] },
    extensions: { getExtension: () => ({ activate: async () => ({ receive: e => received.push(e) }) }) },
    commands: { executeCommand() {} }, window: { showWarningMessage() {} }
  };
  const sandbox = { module: { exports: {} }, require(name) {
    if (name === 'vscode') return vscode;
    if (name === 'node:fs') return { ...fs, lstatSync() { reads++; throw new Error('No snapshot expected'); } };
    return require(name);
  }, setTimeout, clearTimeout, Buffer };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../bridge.js'), 'utf8'), sandbox, { filename: path.join(__dirname, '../bridge.js') });
  const bridge = sandbox.module.exports;
  bridge.attach({ registerInternalNotificationHandler(fn) { handler = fn; return disposable; }, registerProvider() { return disposable; } });
  const start = turn => ({ method: 'turn/started', params: { threadId: 'thread', turn: { id: turn } } });
  const file = turn => ({ method: 'item/completed', params: { threadId: 'thread', turnId: turn, item: { id: 'file', type: 'fileChange', status: 'completed', changes: [{ path: '/tmp/example.txt', diff: '' }] } } });
  const stop = turn => ({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: turn, status: 'completed' } } });
  handler(start('paused'));
  enabled = false; modeChange({ affectsConfiguration: () => true });
  handler(file('paused'));
  enabled = true; modeChange({ affectsConfiguration: () => true });
  handler(file('paused')); handler(stop('paused'));
  await bridge.drain(); assert.equal(reads, 0); assert.equal(received.length, 2); assert.equal(received[1].skipReview, true);
  handler(start('next')); handler(file('next')); handler(stop('next'));
  await bridge.drain(); assert.equal(reads, 1); assert.ok(received.some(e => e.turnId === 'next' && e.type === 'fileChange'));
});
