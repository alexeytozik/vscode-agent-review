'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { handle, atomic, hash } = require('../hook-runner');
const { ReviewModel } = require('../review-model');

for (const stage of ['snapshot', 'emit', 'cleanup']) test('R21 PostToolUse retains recoverable input after ' + stage + ' failure', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-hook-failure.')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const full = path.join(root, 'file.txt'), store = path.join(root, 'store');
  await atomic(path.join(store, 'connection.json'), { root, pid: process.pid, enabled: true, updated: Date.now() });
  const event = { session_id: 'session', turn_id: 'turn', tool_use_id: 'call', tool_name: 'apply_patch', cwd: root, tool_input: { command: '*** Begin Patch\n*** Update File: file.txt\n@@\n-old\n+new\n*** End Patch' } };
  await fs.writeFile(full, 'old\n'); await handle(store, { ...event, hook_event_name: 'PreToolUse' }); await fs.writeFile(full, 'new\n');
  const pending = path.join(store, 'pending', hash('session/turn/call') + '.json');
  const name = stage === 'snapshot' ? 'readFile' : stage === 'emit' ? 'rename' : 'unlink', original = fs[name];
  const mock = t.mock.method(fs, name, async (...args) => {
    if (stage === 'snapshot' && args[0] === full || stage === 'emit' && path.dirname(args[1]) === path.join(store, 'events') || stage === 'cleanup' && args[0] === pending) throw Object.assign(new Error('temporary failure'), { code: 'EIO' });
    return original(...args);
  });
  await assert.rejects(handle(store, { ...event, hook_event_name: 'PostToolUse' }), { code: 'EIO' });
  assert.ok(await fs.stat(pending)); mock.mock.restore(); assert.equal(await fs.readFile(full, 'utf8'), 'new\n');
  await handle(store, { ...event, hook_event_name: 'PostToolUse' });
  await assert.rejects(fs.stat(pending), { code: 'ENOENT' });
  const model = new ReviewModel();
  for (const name of (await fs.readdir(path.join(store, 'events'))).filter(n => n.endsWith('.json')).sort()) for (const event of JSON.parse(await fs.readFile(path.join(store, 'events', name), 'utf8')).records) model.receive(event);
  assert.equal(model.entries().length, 1); assert.equal(model.entries()[0].file.baseline, 'old\n'); assert.equal(model.entries()[0].file.expected, 'new\n'); assert.equal(model.operations.size, 0);
});
